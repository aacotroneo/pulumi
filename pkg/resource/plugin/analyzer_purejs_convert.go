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

package plugin

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/dop251/goja"

	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/pulumi/pulumi/sdk/v3/go/common/util/logging"
	"github.com/pulumi/pulumi/sdk/v3/go/property"
)

// unknownSentinel is the value the node policy SDK sees for an unknown string during preview.
const unknownSentinel = "04da6b54-80e4-46f7-96ec-b56ff0331ba9"

func installJSHostFuncs(rt *goja.Runtime, pack string) error {
	set := func(name string, v any) error { return rt.Set(name, v) }
	if err := set("__log", func(level, msg string) {
		switch level {
		case "error", "warn":
			logging.V(3).Infof("[policy %s] %s: %s", pack, level, msg)
		default:
			logging.V(5).Infof("[policy %s] %s: %s", pack, level, msg)
		}
	}); err != nil {
		return err
	}
	if err := set("__b64dec", func(s string) string {
		s = strings.TrimSpace(s)
		s = strings.NewReplacer("-", "+", "_", "/").Replace(s)
		if b, err := base64.StdEncoding.DecodeString(s); err == nil {
			return string(b)
		}
		b, _ := base64.RawStdEncoding.DecodeString(strings.TrimRight(s, "="))
		return string(b)
	}); err != nil {
		return err
	}
	if err := set("__b64enc", func(s string) string {
		return base64.StdEncoding.EncodeToString([]byte(s))
	}); err != nil {
		return err
	}
	return set("__parseURL", func(input, base string) any {
		u, err := url.Parse(input)
		if err != nil {
			return nil
		}
		if base != "" {
			b, err := url.Parse(base)
			if err != nil {
				return nil
			}
			u = b.ResolveReference(u)
		}
		if u.Scheme == "" {
			return nil
		}
		host := u.Host
		origin := u.Scheme + "://" + host
		search := ""
		if u.RawQuery != "" {
			search = "?" + u.RawQuery
		}
		hash := ""
		if u.Fragment != "" {
			hash = "#" + u.Fragment
		}
		path := u.EscapedPath()
		if path == "" && host != "" {
			path = "/"
		}
		return map[string]any{
			"protocol": u.Scheme + ":",
			"hostname": u.Hostname(),
			"host":     host,
			"port":     u.Port(),
			"pathname": path,
			"search":   search,
			"hash":     hash,
			"href":     u.String(),
			"origin":   origin,
			"username": u.User.Username(),
		}
	})
}

func jsonParse(rt *goja.Runtime, s string) (goja.Value, error) {
	parse, _ := goja.AssertFunction(rt.Get("JSON").ToObject(rt).Get("parse"))
	return parse(goja.Undefined(), rt.ToValue(s))
}

// mapToJS builds native JS objects directly (rather than wrapping Go maps) so that property order is stable, identity
// is preserved across reads, and reads don't go through reflection. Unknown values become getters that throw, matching
// the node SDK's unknown-checking proxy.
func (a *jsAnalyzer) mapToJS(m property.Map, path string) *goja.Object {
	obj := a.rt.NewObject()
	for k, v := range m.AllStable {
		p := joinPath(path, k)
		if v.IsComputed() {
			a.defineUnknown(obj, k, p)
			continue
		}
		_ = obj.Set(k, a.valueToJS(v, p))
	}
	return obj
}

func (a *jsAnalyzer) defineUnknown(obj *goja.Object, key, path string) {
	a.defineGetter(obj, key, "__unknownGetter", path, "")
}

// defineGetter makes obj[key] an accessor that throws, built by the named prelude factory.
func (a *jsAnalyzer) defineGetter(obj *goja.Object, key, factory, path, extra string) {
	getterFactory, _ := goja.AssertFunction(a.rt.Get(factory))
	getter, err := getterFactory(goja.Undefined(), a.rt.ToValue(path), a.rt.ToValue(extra))
	if err != nil {
		_ = obj.Set(key, unknownSentinel)
		return
	}
	_ = obj.DefineAccessorProperty(key, getter, nil, goja.FLAG_TRUE, goja.FLAG_TRUE)
}

func joinPath(path, k string) string {
	if path == "" {
		return k
	}
	return path + "." + k
}

func (a *jsAnalyzer) valueToJS(v property.Value, path string) goja.Value {
	switch {
	case v.IsNull():
		return goja.Null()
	case v.IsBool():
		return a.rt.ToValue(v.AsBool())
	case v.IsNumber():
		return a.rt.ToValue(v.AsNumber())
	case v.IsString():
		return a.rt.ToValue(v.AsString())
	case v.IsMap():
		return a.mapToJS(v.AsMap(), path)
	case v.IsArray():
		arr := v.AsArray()
		hasUnknown := false
		vals := make([]any, arr.Len())
		for i, e := range arr.All {
			if e.IsComputed() {
				hasUnknown = true
				vals[i] = goja.Undefined()
				continue
			}
			vals[i] = a.valueToJS(e, joinPath(path, strconv.Itoa(i)))
		}
		out := a.rt.NewArray(vals...)
		if hasUnknown {
			for i, e := range arr.All {
				if e.IsComputed() {
					a.defineUnknown(out, strconv.Itoa(i), joinPath(path, strconv.Itoa(i)))
				}
			}
		}
		return out
	case v.IsComputed():
		return a.rt.ToValue(unknownSentinel)
	case v.IsAsset():
		as := v.AsAsset()
		o := a.rt.NewObject()
		_ = o.Set(resource.SigKey, as.Sig)
		setIf(o, "hash", as.Hash)
		setIf(o, "text", as.Text)
		setIf(o, "path", as.Path)
		setIf(o, "uri", as.URI)
		return o
	case v.IsArchive():
		ar := v.AsArchive()
		o := a.rt.NewObject()
		_ = o.Set(resource.SigKey, ar.Sig)
		setIf(o, "hash", ar.Hash)
		setIf(o, "path", ar.Path)
		setIf(o, "uri", ar.URI)
		if len(ar.Assets) > 0 {
			_ = o.Set("assets", a.rt.ToValue(ar.Assets))
		}
		return o
	case v.IsResourceReference():
		ref := v.AsResourceReference()
		if id, ok := ref.IDString(); ok && id != "" {
			return a.rt.ToValue(id)
		}
		return a.rt.ToValue(string(ref.URN))
	default:
		return goja.Undefined()
	}
}

func setIf(o *goja.Object, k, v string) {
	if v != "" {
		_ = o.Set(k, v)
	}
}

func (a *jsAnalyzer) stackResourcesToJS(resources []AnalyzerStackResource) *goja.Object {
	vals := make([]any, len(resources))
	for i, r := range resources {
		o := a.rt.NewObject()
		_ = o.Set("type", string(r.Type))
		_ = o.Set("name", r.Name)
		_ = o.Set("urn", string(r.URN))
		_ = o.Set("props", a.mapToJS(r.Properties, ""))
		if r.Parent != "" {
			_ = o.Set("parent", string(r.Parent))
		}
		deps := make([]any, len(r.Dependencies))
		for j, d := range r.Dependencies {
			deps[j] = string(d)
		}
		_ = o.Set("dependencies", a.rt.NewArray(deps...))
		pd := a.rt.NewObject()
		for k, urns := range r.PropertyDependencies {
			us := make([]any, len(urns))
			for j, u := range urns {
				us[j] = string(u)
			}
			_ = pd.Set(string(k), a.rt.NewArray(us...))
		}
		_ = o.Set("propertyDependencies", pd)
		vals[i] = o
	}
	return a.rt.NewArray(vals...)
}

var dumpStackOnce sync.Once

// dumpStack writes what AnalyzeStack received to PULUMI_POLICY_DUMP_STACK (once per process), for debugging.
func dumpStack(path string, resources []AnalyzerStackResource) {
	dumpStackOnce.Do(func() {
		out := make([]map[string]any, len(resources))
		for i, r := range resources {
			out[i] = map[string]any{
				"urn":                  r.URN,
				"type":                 r.Type,
				"id":                   r.ID,
				"parent":               r.Parent,
				"dependencies":         r.Dependencies,
				"propertyDependencies": r.PropertyDependencies,
				"inputs":               dumpValue(property.New(r.Inputs)),
				"unknownInputs":        r.UnknownInputs,
				"outputs":              dumpValue(property.New(r.Properties)),
			}
		}
		b, err := json.MarshalIndent(out, "", "  ")
		if err == nil {
			err = os.WriteFile(path, b, 0o600)
		}
		if err != nil {
			logging.V(3).Infof("dumping stack to %s: %v", path, err)
		}
	})
}

func dumpValue(v property.Value) any {
	switch {
	case v.IsComputed():
		return "<unknown>"
	case v.IsMap():
		m := map[string]any{}
		for k, e := range v.AsMap().All {
			m[k] = dumpValue(e)
		}
		return m
	case v.IsArray():
		var a []any
		for _, e := range v.AsArray().All {
			a = append(a, dumpValue(e))
		}
		return a
	case v.IsString():
		return v.AsString()
	case v.IsNumber():
		return v.AsNumber()
	case v.IsBool():
		return v.AsBool()
	case v.IsNull():
		return nil
	default:
		return fmt.Sprintf("<%v>", v)
	}
}

// refFor names an unknown output: the given property (a dotted path) of the resource with the given URN.
func refFor(urn resource.URN, property string) string {
	sum := sha256.Sum256([]byte(urn))
	return "output-" + hex.EncodeToString(sum[:8]) + "." + property
}

// inputView builds the resources a v2 policy sees. Each has its inputs and its outputs, kept apart. Known values are
// passed as they are. An unknown value that is an output (one of the resource's own outputs, or an input the program's
// SDK reported as another resource's output) is that output's identifiable unknown: one object per output, so it is
// identical wherever it appears. Any other unknown throws UnknownValueError when read.
type inputView struct {
	a        *jsAnalyzer
	byURN    map[resource.URN]*AnalyzerStackResource
	unknown  goja.Callable     // prelude: the identifiable unknown for a ref
	template goja.Callable     // prelude: registers a JSON template's tree and returns its text
	refs     *goja.Object      // ref or template text -> {urn, type, name, property, derived?}
	names    map[string]string // ref -> "name.property", for messages
	linked   int               // unknown inputs that are identified outputs, or templates of them
	unlinked int               // unknown inputs that aren't (derived another way, or no SDK source)
}

func (a *jsAnalyzer) newInputView(resources []AnalyzerStackResource) *inputView {
	unknown, _ := goja.AssertFunction(a.rt.Get("__unknown"))
	template, _ := goja.AssertFunction(a.rt.Get("__template"))
	iv := &inputView{
		a:        a,
		byURN:    make(map[resource.URN]*AnalyzerStackResource, len(resources)),
		unknown:  unknown,
		template: template,
		refs:     a.rt.NewObject(),
		names:    map[string]string{},
	}
	for i := range resources {
		iv.byURN[resources[i].URN] = &resources[i]
	}
	return iv
}

// ref returns the identifiable unknown for the given output of the resource with the given URN.
func (iv *inputView) ref(urn resource.URN, property string) goja.Value {
	ref := refFor(urn, property)
	info := iv.refs.Get(ref)
	if info == nil {
		name, typ := string(urn), "resource"
		if r := iv.byURN[urn]; r != nil {
			name, typ = r.Name, string(r.Type)
		} else if urn.IsValid() {
			name, typ = urn.Name(), string(urn.Type())
		}
		iv.names[ref] = name + "." + property
		o := iv.a.rt.NewObject()
		_ = o.Set("urn", string(urn))
		_ = o.Set("type", typ)
		_ = o.Set("name", name)
		_ = o.Set("property", property)
		_ = iv.refs.Set(ref, o)
		info = o
	}
	v, err := iv.unknown(goja.Undefined(), iv.a.rt.ToValue(ref), info)
	if err != nil {
		return iv.a.rt.ToValue(ref)
	}
	return v
}

func (iv *inputView) toJS(resources []AnalyzerStackResource) *goja.Object {
	rt := iv.a.rt
	vals := make([]any, len(resources))
	for i := range resources {
		r := &resources[i]
		o := rt.NewObject()
		_ = o.Set("type", string(r.Type))
		_ = o.Set("name", r.Name)
		_ = o.Set("urn", string(r.URN))
		inputs := rt.NewObject()
		for k, v := range r.Inputs.AllStable {
			iv.setValue(inputs, k, k, v, r)
		}
		_ = o.Set("inputs", inputs)
		_ = o.Set("outputs", iv.outputsToJS(r))
		if r.Parent != "" {
			_ = o.Set("parent", string(r.Parent))
		}
		deps := make([]any, len(r.Dependencies))
		for j, d := range r.Dependencies {
			deps[j] = string(d)
		}
		_ = o.Set("dependencies", rt.NewArray(deps...))
		pd := rt.NewObject()
		for k, urns := range r.PropertyDependencies {
			us := make([]any, len(urns))
			for j, u := range urns {
				us[j] = string(u)
			}
			_ = pd.Set(string(k), rt.NewArray(us...))
		}
		_ = o.Set("propertyDependencies", pd)
		vals[i] = o
	}
	return rt.NewArray(vals...)
}

// outputsToJS is r's outputs, with each unknown one as that output's identifiable unknown. `id` is always set: the
// resource's ID, or its identifiable unknown while the resource doesn't exist yet.
func (iv *inputView) outputsToJS(r *AnalyzerStackResource) *goja.Object {
	outputs := iv.a.rt.NewObject()
	for k, v := range r.Properties.AllStable {
		iv.setOutput(outputs, k, k, v, r)
	}
	if r.ID != "" {
		_ = outputs.Set("id", string(r.ID))
	} else {
		_ = outputs.Set("id", iv.ref(r.URN, "id"))
	}
	return outputs
}

func (iv *inputView) setOutput(obj *goja.Object, key, path string, v property.Value, r *AnalyzerStackResource) {
	rt := iv.a.rt
	switch {
	case v.IsComputed():
		_ = obj.Set(key, iv.ref(r.URN, path))
	case v.IsMap():
		child := rt.NewObject()
		for k, e := range v.AsMap().AllStable {
			iv.setOutput(child, k, joinPath(path, k), e, r)
		}
		_ = obj.Set(key, child)
	case v.IsArray():
		child := rt.NewArray()
		for i, e := range v.AsArray().All {
			idx := strconv.Itoa(i)
			iv.setOutput(child, idx, joinPath(path, idx), e, r)
		}
		_ = obj.Set(key, child)
	default:
		_ = obj.Set(key, iv.a.valueToJS(v, path))
	}
}

// defineLeaf sets an unknown input at path: the identifiable unknown of the output the program's SDK says it is, the
// text of a template the SDK says it was built from, or a getter that throws when it is derived from outputs some
// other way or the SDK didn't say.
func (iv *inputView) defineLeaf(obj *goja.Object, key, path string, r *AnalyzerStackResource) {
	if v, ok := iv.sourced(r.UnknownInputs[path], r, path); ok {
		iv.linked++
		_ = obj.Set(key, v)
		return
	}
	iv.unlinked++
	iv.a.defineUnknown(obj, key, path)
}

// sourced is the view of an unknown value with the given source, if it has one: the identifiable unknown of an output
// in the stack, or a template whose unknown parts all have one.
func (iv *inputView) sourced(src OutputSource, r *AnalyzerStackResource, path string) (goja.Value, bool) {
	if src.Property != "" {
		if _, inStack := iv.byURN[src.URN]; inStack {
			return iv.ref(src.URN, src.Property), true
		}
		return nil, false
	}
	if src.Template != nil {
		return iv.fromTemplate(src.Template, r, path)
	}
	return nil, false
}

// fromTemplate is the view of a string an SDK built from parts, some of them unknown outputs:
//   - joined parts (interpolate, concat) are the text with each unknown as its ref string, "arn:${ref}/*". A lone
//     unknown with no text around it is that output's identifiable unknown.
//   - a JSON document (jsonStringify) is its text with each unknown as its ref string; JSON.parse on that text gives
//     the document with each unknown as its identifiable unknown.
//
// Either text is guarded like a ref string: it can be compared, but not read into. False if a part is unknown and not
// an output in the stack.
func (iv *inputView) fromTemplate(t *OutputTemplate, r *AnalyzerStackResource, path string) (goja.Value, bool) {
	rt := iv.a.rt
	var text string
	switch t.Kind {
	case "concat":
		if !t.Value.IsArray() {
			return nil, false
		}
		var sb strings.Builder
		var lone goja.Value
		nonEmpty, loneUnknown := 0, false
		for i, part := range t.Value.AsArray().All {
			var v goja.Value
			unknown := part.IsComputed()
			if unknown {
				pv, ok := iv.sourced(t.Unknowns[strconv.Itoa(i)], r, path)
				if !ok {
					return nil, false
				}
				v = pv
			} else {
				v = iv.a.valueToJS(part, path)
			}
			s := v.String()
			if s != "" {
				nonEmpty++
				lone, loneUnknown = v, unknown
			}
			sb.WriteString(s)
		}
		if nonEmpty == 1 && loneUnknown {
			return lone, true
		}
		text = sb.String()
	case "json":
		tree, ok := iv.templateTree(t, "", t.Value, r, path)
		if !ok {
			return nil, false
		}
		v, err := iv.template(goja.Undefined(), tree)
		if err != nil {
			return nil, false
		}
		text = v.String()
	default:
		return nil, false
	}
	info := rt.NewObject()
	_ = info.Set("urn", string(r.URN))
	_ = info.Set("type", string(r.Type))
	_ = info.Set("name", r.Name)
	_ = info.Set("property", path)
	_ = info.Set("derived", true)
	_ = iv.refs.Set(text, info)
	return rt.ToValue(text), true
}

// templateTree is a JSON template's value with each unknown as the view sourced gives it.
func (iv *inputView) templateTree(
	t *OutputTemplate, sub string, v property.Value, r *AnalyzerStackResource, path string,
) (goja.Value, bool) {
	rt := iv.a.rt
	switch {
	case v.IsComputed():
		return iv.sourced(t.Unknowns[sub], r, path)
	case v.IsMap():
		obj := rt.NewObject()
		for k, e := range v.AsMap().AllStable {
			ev, ok := iv.templateTree(t, joinPath(sub, k), e, r, path)
			if !ok {
				return nil, false
			}
			_ = obj.Set(k, ev)
		}
		return obj, true
	case v.IsArray():
		vals := make([]any, 0, v.AsArray().Len())
		for i, e := range v.AsArray().All {
			ev, ok := iv.templateTree(t, joinPath(sub, strconv.Itoa(i)), e, r, path)
			if !ok {
				return nil, false
			}
			vals = append(vals, ev)
		}
		return rt.NewArray(vals...), true
	default:
		return iv.a.valueToJS(v, path), true
	}
}

// setValue sets obj[key] to the view of input v: known values as they are, unknowns per defineLeaf.
func (iv *inputView) setValue(obj *goja.Object, key, path string, v property.Value, r *AnalyzerStackResource) {
	rt := iv.a.rt
	switch {
	case v.IsComputed():
		iv.defineLeaf(obj, key, path, r)
	case v.IsMap():
		child := rt.NewObject()
		for k, e := range v.AsMap().AllStable {
			iv.setValue(child, k, joinPath(path, k), e, r)
		}
		_ = obj.Set(key, child)
	case v.IsArray():
		child := rt.NewArray()
		for i, e := range v.AsArray().All {
			idx := strconv.Itoa(i)
			iv.setValue(child, idx, joinPath(path, idx), e, r)
		}
		_ = obj.Set(key, child)
	default:
		_ = obj.Set(key, iv.a.valueToJS(v, path))
	}
}

var refPattern = regexp.MustCompile(`output-[0-9a-f]{16}\.[A-Za-z0-9_.]+`)

// describeRefs replaces the refs in a policy's message with the outputs they stand for.
func describeRefs(msg string, names map[string]string) string {
	if len(names) == 0 || !strings.Contains(msg, "output-") {
		return msg
	}
	return refPattern.ReplaceAllStringFunc(msg, func(ref string) string {
		// Text after a ref in a joined string ("output-….id.s3.amazonaws.com") also matches: use the longest known
		// ref it starts with.
		for end := len(ref); end > 0; end = strings.LastIndexByte(ref[:end], '.') {
			if n, ok := names[ref[:end]]; ok {
				return "<output " + n + ">" + ref[end:]
			}
		}
		return ref
	})
}
