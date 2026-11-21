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

package policy

// The scan context (hackathon/scan-guardrails): what the scan knows about the program beyond each resource's
// inputs, for policies about code, components and conventions rather than cloud settings.
//
// The analyzer protocol has no free-form field for it, so it rides on the root Stack resource's props, under
// `scan`, in what stack policies see. Resource policies never see the Stack, so existing packs' results don't
// change. A stack policy finds the Stack resource and looks resources up by URN.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/pulumi/pulumi/sdk/v3/go/common/workspace"
)

// scanContextKey is the Stack resource's property that carries the scan context.
const scanContextKey = "scan"

// scanProjectInfo is what the scan context says about the project and stack, from Pulumi.yaml and
// Pulumi.<stack>.yaml.
type scanProjectInfo struct {
	Name        string                    `json:"name"`
	Description string                    `json:"description"`
	Runtime     string                    `json:"runtime"`
	Main        string                    `json:"main,omitempty"`
	Config      map[string]map[string]any `json:"config"`
	// StackConfig is each key set in Pulumi.<stack>.yaml, whether its value is encrypted, and the value if it isn't.
	StackConfig map[string]map[string]any `json:"stackConfig"`
}

func newScanProjectInfo(proj *workspace.Project, projectDir, stack string) (scanProjectInfo, error) {
	info := scanProjectInfo{
		Name:        string(proj.Name),
		Runtime:     proj.Runtime.Name(),
		Main:        proj.Main,
		Config:      map[string]map[string]any{},
		StackConfig: map[string]map[string]any{},
	}
	if proj.Description != nil {
		info.Description = *proj.Description
	}
	fullKey := func(k string) string {
		if !strings.Contains(k, ":") {
			return string(proj.Name) + ":" + k
		}
		return k
	}
	for k, v := range proj.Config {
		c := map[string]any{"description": v.Description, "secret": v.Secret}
		if v.Type != nil {
			c["type"] = *v.Type
		}
		if v.Default != nil {
			c["default"] = v.Default
		}
		if v.Value != nil {
			c["value"] = v.Value
		}
		info.Config[fullKey(k)] = c
	}
	b, err := os.ReadFile(filepath.Join(projectDir, "Pulumi."+stack+".yaml"))
	if errors.Is(err, os.ErrNotExist) {
		return info, nil
	} else if err != nil {
		return info, err
	}
	var doc struct {
		Config map[string]any `yaml:"config"`
	}
	if err := yaml.Unmarshal(b, &doc); err != nil {
		return info, err
	}
	for k, v := range doc.Config {
		secure := false
		if m, ok := v.(map[string]any); ok {
			_, secure = m["secure"]
		}
		entry := map[string]any{"secure": secure}
		// Plain values too, so policies can read per-stack settings (allowed regions, budgets); never secrets.
		if !secure {
			entry["value"] = v
		}
		info.StackConfig[fullKey(k)] = entry
	}
	return info, nil
}

// secretPaths lists the property paths whose values the program marked secret, e.g. `password` or `tags.token`.
func secretPaths(props resource.PropertyMap) []string {
	var out []string
	var walk func(path string, v resource.PropertyValue)
	walk = func(path string, v resource.PropertyValue) {
		switch {
		case v.IsSecret():
			out = append(out, path)
		case v.IsObject():
			for k, e := range v.ObjectValue() {
				walk(path+"."+string(k), e)
			}
		case v.IsArray():
			for i, e := range v.ArrayValue() {
				walk(path+"["+strconv.Itoa(i)+"]", e)
			}
		case v.IsOutput() && v.OutputValue().Secret:
			out = append(out, path)
		}
	}
	for k, v := range props {
		walk(string(k), v)
	}
	sort.Strings(out)
	for i := range out {
		out[i] = strings.TrimPrefix(out[i], ".")
	}
	return out
}

// scanRelFile is a resource's source file relative to the code root, if it's in the program's own code.
func scanRelFile(root string, p *scanPosition) (string, int, int) {
	if p == nil {
		return "", 0, 0
	}
	u := strings.TrimPrefix(p.URI, "file://")
	rel, err := filepath.Rel(root, u)
	if err != nil || strings.HasPrefix(rel, "..") || strings.Contains(rel, "node_modules") {
		return "", 0, 0
	}
	return rel, p.Line, p.Column
}

// buildScanContext assembles the context for the Stack resource. It goes through JSON so it's made of plain
// values only, as the property unmarshaler expects.
func buildScanContext(g *scanGraph, secrets map[string][]string) (map[string]any, error) {
	root := g.CodeRoot
	if root == "" {
		root = g.ProgramDir
	}
	res := map[string]any{}
	for _, r := range g.Resources {
		file, line, col := scanRelFile(root, r.SourcePosition)
		provider := r.Provider
		// A provider reference is "<urn>::<id>"; the id is unknown in a scan.
		if i := strings.LastIndex(provider, "::"); i > 0 && strings.HasPrefix(provider, "urn:") {
			provider = provider[:i]
		}
		entry := map[string]any{
			"file":           file,
			"line":           line,
			"column":         col,
			"custom":         r.Custom,
			"remote":         r.Remote,
			"read":           r.Read,
			"provider":       provider,
			"version":        r.Version,
			"options":        orEmpty(r.Options),
			"secretInputs":   orEmptyList(secrets[r.URN]),
			"createdInApply": r.CreatedInApply,
		}
		if r.Read {
			entry["id"] = r.ID
		}
		res[r.URN] = entry
	}
	ctx := map[string]any{
		"version":   1,
		"stack":     g.Stack,
		"project":   g.info,
		"codeRoot":  root,
		"resources": res,
		"program":   orEmpty(g.Program),
	}
	b, err := json.Marshal(ctx)
	if err != nil {
		return nil, fmt.Errorf("scan context: %w", err)
	}
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, fmt.Errorf("scan context: %w", err)
	}
	return out, nil
}

func orEmptyList(ss []string) []string {
	if ss == nil {
		return []string{}
	}
	return ss
}

// scanFindingPosition lets a policy place a finding on a line of code that isn't a resource's (a config read, an
// import): it reports the violation on `<urn>#<file>:<line>`, with the file relative to the code root.
func scanFindingPosition(urn string) (string, string, int, bool) {
	base, frag, ok := strings.Cut(urn, "#")
	if !ok {
		return urn, "", 0, false
	}
	file, lineStr, _ := strings.Cut(frag, ":")
	line, _ := strconv.Atoi(lineStr)
	return base, file, line, true
}
