// Copyright 2026, Pulumi Corporation.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package deploy

import (
	"strconv"

	"google.golang.org/protobuf/types/known/structpb"

	"github.com/pulumi/pulumi/pkg/v3/resource/plugin"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
)

// collectOutputSources finds the unknown output values in a RegisterResource request's inputs, keyed by their dotted
// path. SDKs that report output sources send an unknown input as an output value carrying the resource and property
// it came from ({"source": {"urn", "property"}}), or only its dependencies when it is derived from outputs, plus how it
// was built when the SDK knows ({"template": {"concat": [parts]}} or {"template": {"json": value}}). The engine
// downgrades these to plain unknowns before providers see them, so this is read from the raw request.
func collectOutputSources(obj *structpb.Struct) map[string]plugin.OutputSource {
	var out map[string]plugin.OutputSource
	for key, v := range obj.GetFields() {
		collectSources(v, key, &out)
	}
	return out
}

func collectSources(v *structpb.Value, path string, out *map[string]plugin.OutputSource) {
	switch k := v.GetKind().(type) {
	case *structpb.Value_ListValue:
		for i, e := range k.ListValue.GetValues() {
			collectSources(e, joinSourcePath(path, strconv.Itoa(i)), out)
		}
	case *structpb.Value_StructValue:
		fields := k.StructValue.GetFields()
		switch fields[resource.SigKey].GetStringValue() {
		case "":
			for key, e := range fields {
				collectSources(e, joinSourcePath(path, key), out)
			}
		case resource.SecretSig:
			if e, ok := fields["value"]; ok {
				collectSources(e, path, out)
			}
		case resource.OutputValueSig:
			if _, known := fields["value"]; known {
				return
			}
			var src plugin.OutputSource
			if s := fields["source"].GetStructValue(); s != nil {
				src.URN = resource.URN(s.GetFields()["urn"].GetStringValue())
				src.Property = s.GetFields()["property"].GetStringValue()
			}
			for _, d := range fields["dependencies"].GetListValue().GetValues() {
				src.Dependencies = append(src.Dependencies, resource.URN(d.GetStringValue()))
			}
			src.Template = collectTemplate(fields["template"].GetStructValue())
			if src.URN == "" && src.Property == "" && len(src.Dependencies) == 0 && src.Template == nil {
				return
			}
			if *out == nil {
				*out = map[string]plugin.OutputSource{}
			}
			(*out)[path] = src
		}
	}
}

// collectTemplate reads an output value's template: its parts, with the unknown ones' sources.
func collectTemplate(t *structpb.Struct) *plugin.OutputTemplate {
	var kind string
	var v *structpb.Value
	if c, ok := t.GetFields()["concat"]; ok {
		kind, v = "concat", c
	} else if j, ok := t.GetFields()["json"]; ok {
		kind, v = "json", j
	} else {
		return nil
	}
	pv, err := plugin.UnmarshalPropertyValue("template", v, plugin.MarshalOptions{KeepUnknowns: true})
	if err != nil || pv == nil {
		return nil
	}
	tmpl := &plugin.OutputTemplate{Kind: kind, Value: resource.FromResourcePropertyValue(*pv)}
	collectSources(v, "", &tmpl.Unknowns)
	return tmpl
}

func joinSourcePath(path, k string) string {
	if path == "" {
		return k
	}
	return path + "." + k
}
