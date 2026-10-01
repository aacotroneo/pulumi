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
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dop251/goja"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/pulumi/pulumi/sdk/v3/go/common/tokens"
	"github.com/pulumi/pulumi/sdk/v3/go/common/util/logging"
	"github.com/pulumi/pulumi/sdk/v3/go/common/workspace"
)

// PureJSPolicyRuntime is the PulumiPolicy.yaml runtime name for policy packs that are a single self-contained JS file
// of pure functions, evaluated in-process with goja instead of in a node analyzer process.
const PureJSPolicyRuntime = "purejs"

//go:embed analyzer_purejs_prelude.js
var jsPreludeSrc string

var jsPrelude = sync.OnceValue(func() *goja.Program {
	return goja.MustCompile("prelude.js", jsPreludeSrc, true)
})

func jsTimingEnabled() bool { return os.Getenv("PULUMI_POLICY_TIMING") != "" }

type jsPackDesc struct {
	AbiVersion       int                      `json:"abiVersion"`
	Name             string                   `json:"name"`
	Version          string                   `json:"version"`
	DisplayName      string                   `json:"displayName"`
	Description      string                   `json:"description"`
	EnforcementLevel apitype.EnforcementLevel `json:"enforcementLevel"`
	Readme           string                   `json:"readme"`
	Provider         string                   `json:"provider"`
	Repository       string                   `json:"repository"`
	Tags             []string                 `json:"tags"`
	InitialConfig    map[string]any           `json:"initialConfig"`
	Policies         []jsPolicyDesc           `json:"policies"`
}

type jsPolicyDesc struct {
	Name             string                   `json:"name"`
	DisplayName      string                   `json:"displayName"`
	Description      string                   `json:"description"`
	Message          string                   `json:"message"`
	EnforcementLevel apitype.EnforcementLevel `json:"enforcementLevel"`
	Severity         apitype.PolicySeverity   `json:"severity"`
	Framework        *struct {
		Name          string `json:"name"`
		Version       string `json:"version"`
		Reference     string `json:"reference"`
		Specification string `json:"specification"`
	} `json:"framework"`
	Tags             []string `json:"tags"`
	RemediationSteps string   `json:"remediationSteps"`
	URL              string   `json:"url"`
	ConfigSchema     *struct {
		Properties map[string]JSONSchema `json:"properties"`
		Required   []string              `json:"required"`
	} `json:"configSchema"`
	Kind  string `json:"kind"`  // ABI v1 only
	Scope string `json:"scope"` // rejected in ABI v2, which infers it from ResourceTypes
	// ResourceTypes filters the resources a policy sees. In ABI v2 it also makes the policy run once per matching
	// resource; "*" matches every resource.
	ResourceTypes []string `json:"resourceTypes"`
}

type jsPolicy struct {
	desc     jsPolicyDesc
	kind     AnalyzerPolicyType
	types    map[string]struct{} // nil means every type
	validate goja.Value
	level    apitype.EnforcementLevel // resolved default, then overridden by Configure
	config   goja.Value

	// input is set for ABI v2 policies (Input Policies), which are evaluated in AnalyzeStack against the input view.
	input        bool
	perResource  bool
	outputAccess atomic.Int64
}

type jsAnalyzer struct {
	name        tokens.QName
	dir         string
	main        string
	yamlVersion string
	yamlDesc    string

	ready   chan struct{}
	loadErr error

	mu         sync.Mutex
	rt         *goja.Runtime
	invoke     goja.Callable
	beginInput goja.Callable
	endInput   goja.Callable
	refNames   map[string]string // while Input Policies run: ref -> the output it stands for, for messages
	pack       jsPackDesc
	version    string
	policies   []*jsPolicy
	info       AnalyzerInfo

	analyzeCalls atomic.Int64
	analyzeNanos atomic.Int64
}

var _ Analyzer = (*jsAnalyzer)(nil)

// newJSAnalyzer returns immediately and loads the pack in the background. The host creates analyzers on a single
// loader goroutine, so compiling inline would serialize every pack's load.
func newJSAnalyzer(name tokens.QName, dir string, proj *workspace.PolicyPackProject) (Analyzer, error) {
	main := proj.Main
	if main == "" {
		main = "policies.js"
	}
	a := &jsAnalyzer{
		name:        name,
		dir:         dir,
		main:        filepath.Join(dir, main),
		yamlVersion: proj.Version,
		ready:       make(chan struct{}),
	}
	if proj.Description != nil {
		a.yamlDesc = *proj.Description
	}
	go func() {
		defer close(a.ready)
		a.loadErr = a.load()
		if a.loadErr != nil {
			logging.V(3).Infof("purejs pack %s failed to load: %v", name, a.loadErr)
		}
	}()
	return a, nil
}

func (a *jsAnalyzer) load() error {
	t0 := time.Now()
	src, err := os.ReadFile(a.main)
	if err != nil {
		return fmt.Errorf("reading policy pack bundle: %w", err)
	}
	tRead := time.Now()
	prog, err := goja.Compile(a.main, string(src), false)
	if err != nil {
		return fmt.Errorf("compiling policy pack bundle %s: %w", a.main, err)
	}
	tCompile := time.Now()

	rt := goja.New()
	rt.SetMaxCallStackSize(4096)
	if err := installJSHostFuncs(rt, string(a.name)); err != nil {
		return err
	}
	if _, err := rt.RunProgram(jsPrelude()); err != nil {
		return fmt.Errorf("running policy prelude: %w", err)
	}
	if _, err := rt.RunProgram(prog); err != nil {
		return fmt.Errorf("evaluating policy pack bundle %s: %w", a.main, err)
	}
	tEval := time.Now()

	describe, _ := goja.AssertFunction(rt.Get("__describe"))
	descJSON, err := describe(goja.Undefined())
	if err != nil {
		return fmt.Errorf("reading policy pack descriptor: %w", err)
	}
	var pack jsPackDesc
	if err := json.Unmarshal([]byte(descJSON.String()), &pack); err != nil {
		return fmt.Errorf("decoding policy pack descriptor: %w", err)
	}
	invoke, ok := goja.AssertFunction(rt.Get("__invoke"))
	if !ok {
		return errors.New("prelude is missing __invoke")
	}
	beginInput, _ := goja.AssertFunction(rt.Get("__beginInput"))
	endInput, _ := goja.AssertFunction(rt.Get("__endInput"))

	jsPolicies := rt.Get("__pulumiPolicyPack").ToObject(rt).Get("policies").ToObject(rt)
	packLevel := pack.EnforcementLevel
	if packLevel == "" {
		packLevel = apitype.Advisory
	}
	policies := make([]*jsPolicy, len(pack.Policies))
	for i, d := range pack.Policies {
		if d.Name == "all" {
			return errors.New(`policy pack cannot contain a policy named "all"`)
		}
		if d.ConfigSchema != nil {
			if _, has := d.ConfigSchema.Properties["enforcementLevel"]; has {
				return fmt.Errorf("policy %q: configSchema cannot contain an enforcementLevel property", d.Name)
			}
		}
		validate := jsPolicies.Get(strconv.Itoa(i)).ToObject(rt).Get("validate")
		if _, ok := goja.AssertFunction(validate); !ok {
			return fmt.Errorf("policy %q has no validate function", d.Name)
		}
		p := &jsPolicy{desc: d, validate: validate, config: rt.NewObject()}
		if pack.AbiVersion >= 2 {
			// ABI v2 has one kind of policy: with resourceTypes it runs once per matching resource, without them once
			// per stack. Every policy needs the whole graph, so they all run in AnalyzeStack and are summarized as
			// stack policies.
			if d.Kind != "" || d.Scope != "" {
				return fmt.Errorf("policy %q: ABI v2 policies have no kind or scope; rebuild the pack", d.Name)
			}
			p.kind, p.input, p.perResource = AnalyzerPolicyTypeStack, true, len(d.ResourceTypes) > 0
		} else {
			switch d.Kind {
			case "stack":
				p.kind = AnalyzerPolicyTypeStack
			case "resource", "":
				p.kind = AnalyzerPolicyTypeResource
			default:
				return fmt.Errorf("policy %q has unknown kind %q", d.Name, d.Kind)
			}
		}
		if len(d.ResourceTypes) > 0 && !slices.Contains(d.ResourceTypes, "*") {
			p.types = make(map[string]struct{}, len(d.ResourceTypes))
			for _, t := range d.ResourceTypes {
				p.types[t] = struct{}{}
			}
		}
		p.level = d.EnforcementLevel
		if p.level == "" {
			p.level = packLevel
		}
		policies[i] = p
	}

	a.rt, a.invoke, a.pack, a.policies = rt, invoke, pack, policies
	a.beginInput, a.endInput = beginInput, endInput
	a.version = pack.Version
	if a.yamlVersion != "" {
		a.version = a.yamlVersion
	}
	a.info = a.buildInfo()
	tDone := time.Now()

	msg := fmt.Sprintf("purejs pack %s: %d policies, %dKB, read=%s compile=%s eval=%s describe=%s total=%s",
		pack.Name, len(policies), len(src)/1024, tRead.Sub(t0), tCompile.Sub(tRead), tEval.Sub(tCompile),
		tDone.Sub(tEval), tDone.Sub(t0))
	logging.V(3).Infof("%s", msg)
	if jsTimingEnabled() {
		fmt.Fprintf(os.Stderr, "[policy-timing] %s\n", msg)
	}
	return nil
}

func (a *jsAnalyzer) buildInfo() AnalyzerInfo {
	policies := make([]AnalyzerPolicyInfo, len(a.policies))
	for i, p := range a.policies {
		d := p.desc
		schema := &AnalyzerPolicyConfigSchema{Properties: map[string]JSONSchema{}}
		if d.ConfigSchema != nil {
			maps.Copy(schema.Properties, d.ConfigSchema.Properties)
			schema.Required = d.ConfigSchema.Required
		}
		schema.Properties["enforcementLevel"] = JSONSchema{
			"type": "string",
			"enum": []string{"advisory", "mandatory", "remediate", "disabled"},
		}
		var fw *AnalyzerPolicyComplianceFramework
		if d.Framework != nil {
			fw = &AnalyzerPolicyComplianceFramework{
				Name: d.Framework.Name, Version: d.Framework.Version,
				Reference: d.Framework.Reference, Specification: d.Framework.Specification,
			}
		}
		policies[i] = AnalyzerPolicyInfo{
			Name:             d.Name,
			DisplayName:      d.DisplayName,
			Description:      d.Description,
			EnforcementLevel: p.level,
			Message:          d.Message,
			ConfigSchema:     schema,
			Type:             p.kind,
			Severity:         d.Severity,
			Framework:        fw,
			Tags:             d.Tags,
			RemediationSteps: d.RemediationSteps,
			URL:              d.URL,
		}
	}
	sort.Slice(policies, func(i, j int) bool { return policies[i].Name < policies[j].Name })

	description := a.pack.Description
	if description == "" {
		description = a.yamlDesc
	}
	return AnalyzerInfo{
		Name:           a.pack.Name,
		DisplayName:    a.pack.DisplayName,
		Version:        a.version,
		SupportsConfig: true,
		Policies:       policies,
		InitialConfig:  convertJSInitialConfig(a.pack.InitialConfig),
		Description:    description,
		Readme:         a.pack.Readme,
		Provider:       a.pack.Provider,
		Tags:           a.pack.Tags,
		Repository:     a.pack.Repository,
	}
}

func convertJSInitialConfig(c map[string]any) map[string]AnalyzerPolicyConfig {
	if len(c) == 0 {
		return nil
	}
	out := make(map[string]AnalyzerPolicyConfig, len(c))
	for k, v := range c {
		switch v := v.(type) {
		case string:
			out[k] = AnalyzerPolicyConfig{EnforcementLevel: apitype.EnforcementLevel(v)}
		case map[string]any:
			cfg := AnalyzerPolicyConfig{Properties: map[string]any{}}
			for pk, pv := range v {
				if pk == "enforcementLevel" {
					if s, ok := pv.(string); ok {
						cfg.EnforcementLevel = apitype.EnforcementLevel(s)
					}
					continue
				}
				cfg.Properties[pk] = pv
			}
			out[k] = cfg
		}
	}
	return out
}

func (a *jsAnalyzer) wait(ctx context.Context) error {
	select {
	case <-a.ready:
		return a.loadErr
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (a *jsAnalyzer) Name() tokens.QName { return a.name }

func (a *jsAnalyzer) Analyze(ctx context.Context, r AnalyzerResource) (AnalyzeResponse, error) {
	if err := a.wait(ctx); err != nil {
		return AnalyzeResponse{}, err
	}
	start := time.Now()
	a.mu.Lock()
	defer func() {
		a.mu.Unlock()
		a.analyzeCalls.Add(1)
		a.analyzeNanos.Add(int64(time.Since(start)))
	}()

	var resp AnalyzeResponse
	var input *goja.Object
	typ := string(r.Type)
	for _, p := range a.policies {
		if p.kind != AnalyzerPolicyTypeResource || p.level == apitype.Disabled {
			continue
		}
		if p.types != nil {
			if _, ok := p.types[typ]; !ok {
				// Mirror the node SDK: only a single-typed policy is reported as not applicable; a policy with several
				// typed validations runs them all as no-ops and counts as passed.
				if len(p.desc.ResourceTypes) == 1 {
					resp.NotApplicable = append(resp.NotApplicable, PolicyNotApplicable{
						PolicyName: p.desc.Name,
						Reason:     fmt.Sprintf("Policy only applies to resources of type '%s'", p.desc.ResourceTypes[0]),
					})
				}
				continue
			}
		}
		if input == nil {
			input = a.rt.NewObject()
			_ = input.Set("type", typ)
			_ = input.Set("name", r.Name)
			_ = input.Set("urn", string(r.URN))
			_ = input.Set("props", a.mapToJS(r.Properties, ""))
		}
		_ = input.Set("config", p.config)
		if _, err := a.run(p, input, &resp); err != nil {
			return AnalyzeResponse{}, err
		}
	}
	return resp, nil
}

func (a *jsAnalyzer) AnalyzeStack(ctx context.Context, resources []AnalyzerStackResource) (AnalyzeResponse, error) {
	if err := a.wait(ctx); err != nil {
		return AnalyzeResponse{}, err
	}
	if path := os.Getenv("PULUMI_POLICY_DUMP_STACK"); path != "" {
		dumpStack(path, resources)
	}
	a.mu.Lock()
	defer a.mu.Unlock()

	var resp AnalyzeResponse
	var input *goja.Object
	for _, p := range a.policies {
		if p.kind != AnalyzerPolicyTypeStack || p.input || p.level == apitype.Disabled {
			continue
		}
		if p.types != nil {
			found := false
			for _, r := range resources {
				if _, ok := p.types[string(r.Type)]; ok {
					found = true
					break
				}
			}
			if !found {
				resp.NotApplicable = append(resp.NotApplicable, PolicyNotApplicable{
					PolicyName: p.desc.Name,
					Reason:     fmt.Sprintf("Policy only applies to resources of type '%s'", p.desc.ResourceTypes[0]),
				})
				continue
			}
		}
		if input == nil {
			input = a.rt.NewObject()
			_ = input.Set("resources", a.stackResourcesToJS(resources))
		}
		_ = input.Set("config", p.config)
		if _, err := a.run(p, input, &resp); err != nil {
			return AnalyzeResponse{}, err
		}
	}
	if err := a.analyzeInputs(resources, &resp); err != nil {
		return AnalyzeResponse{}, err
	}
	return resp, nil
}

// analyzeInputs runs the pack's Input Policies against the input view of the stack.
func (a *jsAnalyzer) analyzeInputs(resources []AnalyzerStackResource, resp *AnalyzeResponse) error {
	var inputs []*jsPolicy
	for _, p := range a.policies {
		if p.input && p.level != apitype.Disabled {
			inputs = append(inputs, p)
		}
	}
	if len(inputs) == 0 {
		return nil
	}
	start := time.Now()
	iv := a.newInputView(resources)
	all := iv.toJS(resources)
	if _, err := a.beginInput(goja.Undefined(), iv.refs); err != nil {
		return fmt.Errorf("preparing input view: %w", err)
	}
	a.refNames = iv.names
	defer func() {
		_, _ = a.endInput(goja.Undefined())
		a.refNames = nil
	}()
	built := time.Since(start)

	n := len(resources)
	for _, p := range inputs {
		matches := make([]int, 0, n)
		for i := range n {
			if p.types == nil {
				matches = append(matches, i)
			} else if _, ok := p.types[string(resources[i].Type)]; ok {
				matches = append(matches, i)
			}
		}
		if len(matches) == 0 && p.types != nil {
			resp.NotApplicable = append(resp.NotApplicable, PolicyNotApplicable{
				PolicyName: p.desc.Name,
				Reason:     "no resources of type " + strings.Join(p.desc.ResourceTypes, ", "),
			})
			continue
		}
		// Outcomes are explicit: a policy that reported neither a violation nor a pass is not applicable.
		diags, passes := len(resp.Diagnostics), 0
		invoke := func(resource goja.Value) error {
			input := a.rt.NewObject()
			if resource != nil {
				_ = input.Set("resource", resource)
			}
			_ = input.Set("resources", all)
			_ = input.Set("config", p.config)
			n, err := a.run(p, input, resp)
			passes += n
			return err
		}
		if p.perResource {
			for _, i := range matches {
				if err := invoke(all.Get(strconv.Itoa(i))); err != nil {
					return err
				}
			}
		} else if err := invoke(nil); err != nil {
			return err
		}
		if len(resp.Diagnostics) == diags && passes == 0 {
			resp.NotApplicable = append(resp.NotApplicable, PolicyNotApplicable{
				PolicyName: p.desc.Name,
				Reason:     "policy reported no result",
			})
		}
	}
	msg := fmt.Sprintf(
		"purejs pack %s: input view of %d resources built in %s (linked unknowns=%d, unlinked=%d), "+
			"%d input policies ran in %s",
		a.pack.Name, n, built, iv.linked, iv.unlinked, len(inputs), time.Since(start)-built)
	logging.V(5).Infof("%s", msg)
	if jsTimingEnabled() {
		fmt.Fprintf(os.Stderr, "[policy-timing] %s\n", msg)
	}
	return nil
}

// run invokes one policy and appends its violations/not-applicable result to resp. It returns the number of passes
// the policy reported (ABI v2 only).
func (a *jsAnalyzer) run(p *jsPolicy, input *goja.Object, resp *AnalyzeResponse) (int, error) {
	res, err := a.invoke(goja.Undefined(), p.validate, input, a.rt.ToValue(p.input))
	if err != nil {
		return 0, fmt.Errorf("Error validating resource with policy '%s' from policy pack '%s@v%s': %w",
			p.desc.Name, a.pack.Name, a.version, err)
	}
	obj := res.ToObject(a.rt)
	passes := 0
	if ps, ok := obj.Get("p").Export().([]any); ok {
		passes = len(ps)
	}

	level := p.level
	if level == apitype.Remediate {
		level = apitype.Mandatory
	}
	if vs, ok := obj.Get("v").Export().([]any); ok {
		for _, v := range vs {
			pair, _ := v.([]any)
			if len(pair) == 0 {
				continue
			}
			var urn string
			if len(pair) > 1 {
				urn, _ = pair[1].(string)
			}
			resp.Diagnostics = append(resp.Diagnostics, a.violation(p, level, pair[0], urn))
		}
	}
	if na := obj.Get("na"); na != nil && !goja.IsUndefined(na) {
		resp.NotApplicable = append(resp.NotApplicable, PolicyNotApplicable{PolicyName: p.desc.Name, Reason: na.String()})
	}
	if out := obj.Get("out"); out != nil && !goja.IsUndefined(out) {
		p.outputAccess.Add(1)
		resp.Diagnostics = append(resp.Diagnostics, AnalyzeDiagnostic{
			PolicyName:        p.desc.Name,
			PolicyPackName:    a.pack.Name,
			PolicyPackVersion: a.version,
			Description:       p.desc.Description,
			Message: fmt.Sprintf("policy '%s' from policy pack '%s@v%s' reads the contents of an output (%s); "+
				"Input Policies can only compare outputs for equality",
				p.desc.Name, a.pack.Name, a.version, out.String()),
			EnforcementLevel: apitype.Advisory,
			URN:              resource.URN(stringProp(obj, "outUrn")),
			Severity:         p.desc.Severity,
		})
	}
	if unk := obj.Get("unk"); unk != nil && !goja.IsUndefined(unk) {
		resp.Diagnostics = append(resp.Diagnostics, AnalyzeDiagnostic{
			PolicyName:        p.desc.Name,
			PolicyPackName:    a.pack.Name,
			PolicyPackVersion: a.version,
			Description:       p.desc.Description,
			Message: fmt.Sprintf("can't run policy '%s' from policy pack '%s@v%s' during preview: %s",
				p.desc.Name, a.pack.Name, a.version, unk.String()),
			EnforcementLevel: apitype.Advisory,
			URN:              resource.URN(stringProp(obj, "outUrn")),
			Severity:         p.desc.Severity,
		})
	}
	return passes, nil
}

// violation builds a diagnostic from a reportViolation call, following the node SDK's makeReportViolationFun.
func (a *jsAnalyzer) violation(
	p *jsPolicy, level apitype.EnforcementLevel, m any, urn string,
) AnalyzeDiagnostic {
	d := AnalyzeDiagnostic{
		PolicyName:        p.desc.Name,
		PolicyPackName:    a.pack.Name,
		PolicyPackVersion: a.version,
		Description:       p.desc.Description,
		EnforcementLevel:  level,
		URN:               resource.URN(urn),
		Severity:          p.desc.Severity,
	}
	if obj, ok := m.(map[string]any); ok {
		str := func(k string) string { s, _ := obj[k].(string); return s }
		if s := str("name"); s != "" {
			d.PolicyName = s
		}
		if s := str("description"); s != "" {
			d.Description = s
		}
		d.Message = describeRefs(str("message"), a.refNames)
		if d.Message == "" {
			d.Message = d.Description
		}
		if u := str("urn"); u != "" {
			d.URN = resource.URN(u)
		}
		if s := str("enforcementLevel"); s != "" {
			d.EnforcementLevel = apitype.EnforcementLevel(s)
		}
		if s := str("severity"); s != "" {
			d.Severity = apitype.PolicySeverity(s)
		}
		return d
	}
	msg := ""
	if m != nil {
		msg = describeRefs(fmt.Sprint(m), a.refNames)
	}
	d.Message = p.desc.Description
	if msg != "" {
		d.Message += "\n" + msg
	}
	return d
}

func (a *jsAnalyzer) Remediate(ctx context.Context, r AnalyzerResource) (RemediateResponse, error) {
	return RemediateResponse{}, nil
}

func (a *jsAnalyzer) GetAnalyzerInfo(ctx context.Context) (AnalyzerInfo, error) {
	if err := a.wait(ctx); err != nil {
		return AnalyzerInfo{}, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.info, nil
}

func (a *jsAnalyzer) GetPluginInfo(ctx context.Context) (PluginInfo, error) {
	return PluginInfo{}, nil
}

func (a *jsAnalyzer) Configure(ctx context.Context, policyConfig map[string]AnalyzerPolicyConfig) error {
	if len(policyConfig) == 0 {
		return nil
	}
	if err := a.wait(ctx); err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()

	for _, p := range a.policies {
		c, ok := policyConfig[p.desc.Name]
		if !ok {
			continue
		}
		if c.EnforcementLevel != "" {
			if !c.EnforcementLevel.IsValid() {
				return fmt.Errorf("invalid enforcement level %q", c.EnforcementLevel)
			}
			p.level = c.EnforcementLevel
		}
		props := make(map[string]any, len(c.Properties))
		for k, v := range c.Properties {
			if k != "enforcementLevel" {
				props[k] = v
			}
		}
		b, err := json.Marshal(props)
		if err != nil {
			return fmt.Errorf("marshalling config for policy %q: %w", p.desc.Name, err)
		}
		cfg, err := jsonParse(a.rt, string(b))
		if err != nil {
			return fmt.Errorf("converting config for policy %q: %w", p.desc.Name, err)
		}
		p.config = cfg
	}
	for i, pi := range a.info.Policies {
		if c, ok := policyConfig[pi.Name]; ok && c.EnforcementLevel != "" {
			a.info.Policies[i].EnforcementLevel = c.EnforcementLevel
		}
	}
	return nil
}

func (a *jsAnalyzer) Cancel(ctx context.Context) error {
	if rt := a.loadedRuntime(); rt != nil {
		rt.Interrupt("cancelled")
	}
	return nil
}

func (a *jsAnalyzer) Close() error {
	if jsTimingEnabled() {
		fmt.Fprintf(os.Stderr, "[policy-timing] purejs pack %s: analyze calls=%d total=%s\n",
			a.name, a.analyzeCalls.Load(), time.Duration(a.analyzeNanos.Load()))
		var reads []string
		for _, p := range a.policies {
			if n := p.outputAccess.Load(); n > 0 {
				reads = append(reads, fmt.Sprintf("%s=%d", p.desc.Name, n))
			}
		}
		if len(reads) > 0 {
			fmt.Fprintf(os.Stderr, "[policy-timing] purejs pack %s: output reads: %v\n", a.name, reads)
		}
	}
	return nil
}

func stringProp(obj *goja.Object, key string) string {
	if v := obj.Get(key); v != nil && !goja.IsUndefined(v) && !goja.IsNull(v) {
		return v.String()
	}
	return ""
}

func (a *jsAnalyzer) loadedRuntime() *goja.Runtime {
	select {
	case <-a.ready:
		return a.rt
	default:
		return nil
	}
}
