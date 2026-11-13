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

// Hackathon: `pulumi policy lint`, policies on a program folder with no engine, providers, credentials or
// installed project dependencies.

package policy

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"google.golang.org/protobuf/types/known/structpb"
	"gopkg.in/yaml.v3"

	cmdBackend "github.com/pulumi/pulumi/pkg/v3/cmd/pulumi/backend"
	cmdCmd "github.com/pulumi/pulumi/pkg/v3/cmd/pulumi/cmd"
	"github.com/pulumi/pulumi/pkg/v3/cmd/pulumi/packageworkspace"
	"github.com/pulumi/pulumi/pkg/v3/codegen/convert"
	"github.com/pulumi/pulumi/pkg/v3/codegen/schema"
	"github.com/pulumi/pulumi/pkg/v3/engine"
	pkghost "github.com/pulumi/pulumi/pkg/v3/host"
	"github.com/pulumi/pulumi/pkg/v3/resource/deploy"
	"github.com/pulumi/pulumi/pkg/v3/resource/plugin"
	pkgWorkspace "github.com/pulumi/pulumi/pkg/v3/workspace"
	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/pulumi/pulumi/sdk/v3/go/common/env"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/pulumi/pulumi/sdk/v3/go/common/util/cmdutil"
	"github.com/pulumi/pulumi/sdk/v3/go/common/util/contract"
	"github.com/pulumi/pulumi/sdk/v3/go/common/workspace"
	"github.com/pulumi/pulumi/sdk/v3/go/property"
)

//go:embed lint/scan.js
var lintScanJS []byte

type lintGraph struct {
	Project    string           `json:"project"`
	Stack      string           `json:"stack"`
	ProgramDir string           `json:"programDir"`
	CodeRoot   string           `json:"codeRoot"`
	Resources  []lintResource   `json:"resources"`
	Stubs      []string         `json:"stubs"`
	Missing    []string         `json:"missingConfig"`
	Assumed    []string         `json:"assumedArtifacts"`
	Network    []string         `json:"networkBlocked"`
	Fixtures   []string         `json:"usedFixtures"`
	Unmocked   []string         `json:"unknownInvokes"`
	Probed     int              `json:"probedApplies"`
	Failed     int              `json:"failedApplies"`
	Errors     []lintMessage    `json:"errors"`
	Warnings   []lintMessage    `json:"warnings"`
	Timings    map[string]int64 `json:"timings"`
}

type lintMessage struct {
	Message string `json:"message"`
}

type lintPosition struct {
	URI    string `json:"uri"`
	Line   int    `json:"line"`
	Column int    `json:"column"`
}

type lintResource struct {
	URN                  string              `json:"urn"`
	Type                 string              `json:"type"`
	Name                 string              `json:"name"`
	Custom               bool                `json:"custom"`
	Remote               bool                `json:"remote"`
	Read                 bool                `json:"read"`
	ID                   string              `json:"id"`
	Parent               string              `json:"parent"`
	Dependencies         []string            `json:"dependencies"`
	PropertyDependencies map[string][]string `json:"propertyDependencies"`
	Provider             string              `json:"provider"`
	SourcePosition       *lintPosition       `json:"sourcePosition"`
	Object               map[string]any      `json:"object"`
}

// LintFinding is one policy result tied to a source position. The shape maps one-to-one onto an LSP
// diagnostic or a GitHub check annotation.
type LintFinding struct {
	URI              string `json:"uri,omitempty"`
	File             string `json:"file,omitempty"`
	Line             int    `json:"line,omitempty"`
	Column           int    `json:"column,omitempty"`
	URN              string `json:"urn"`
	Type             string `json:"type"`
	Name             string `json:"name"`
	PolicyPack       string `json:"policyPack"`
	PolicyPackVer    string `json:"policyPackVersion"`
	Policy           string `json:"policy"`
	Description      string `json:"description,omitempty"`
	Severity         string `json:"severity,omitempty"`
	EnforcementLevel string `json:"enforcementLevel"`
	Message          string `json:"message"`
}

type lintReport struct {
	Project    string           `json:"project"`
	ProgramDir string           `json:"programDir"`
	Resources  int              `json:"resources"`
	Findings   []LintFinding    `json:"findings"`
	Advisories []LintFinding    `json:"advisories"`
	Stubs      []string         `json:"stubs"`
	Missing    []string         `json:"missingConfig"`
	Assumed    []string         `json:"assumedArtifacts"`
	Network    []string         `json:"networkBlocked"`
	Fixtures   []string         `json:"usedFixtures"`
	Unmocked   []string         `json:"unknownInvokes"`
	Probed     int              `json:"probedApplies"`
	Failed     int              `json:"failedApplies"`
	Errors     []string         `json:"errors"`
	Timings    map[string]int64 `json:"timings"`
}

func newPolicyLintCmd() *cobra.Command {
	var policyPackPaths []string
	var policyPackConfigs []string
	var stackName string
	var configOverrides []string
	var fixturesFile string
	var jsonOut bool
	var graphOut string
	var sdkDir string
	var cacheDir string

	cmd := &cobra.Command{
		Use:    "lint [dir]",
		Hidden: true,
		Short:  "Check a program's code against policy packs, without running a deployment",
		Long: "Check a Pulumi program's code against local policy packs without an engine, providers,\n" +
			"cloud credentials, a stack or the program's dependencies installed.\n" +
			"\n" +
			"The program runs against an in-process recorder, as in a preview: inputs are real, and\n" +
			"every output is an identifiable unknown. Only Node.js programs are supported.",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			start := time.Now()
			if len(policyPackPaths) == 0 {
				return errors.New("at least one --policy-pack path must be specified")
			}
			if len(policyPackConfigs) > 0 && len(policyPackConfigs) != len(policyPackPaths) {
				return errors.New(
					"the number of --policy-pack-config paths must match the number of --policy-pack paths")
			}

			dir := "."
			if len(args) > 0 {
				dir = args[0]
			}
			dir, err := filepath.Abs(dir)
			if err != nil {
				return err
			}
			projPath, err := workspace.DetectProjectPathFrom(dir)
			if err != nil || projPath == "" {
				return fmt.Errorf("no Pulumi.yaml found in %s or its parents", dir)
			}
			proj, err := workspace.LoadProject(projPath)
			if err != nil {
				return err
			}
			programDir := filepath.Dir(projPath)
			if rt := proj.Runtime.Name(); rt != "nodejs" {
				fmt.Fprintf(cmd.ErrOrStderr(), "policy lint: runtime %q is not supported yet; skipping %s\n", rt, programDir)
				return nil
			}
			// `main` is a directory (the program root) or the entry file.
			mainFile := ""
			if proj.Main != "" {
				p := filepath.Join(programDir, proj.Main)
				if fi, err := os.Stat(p); err == nil && fi.IsDir() {
					programDir = p
				} else {
					mainFile = proj.Main
				}
			}

			if sdkDir == "" {
				sdkDir = defaultLintSDK()
			}
			if sdkDir == "" {
				return errors.New("set PULUMI_LINT_SDK (or --sdk) to a built @pulumi/pulumi with policy output sources")
			}
			if cacheDir == "" {
				home, err := workspace.GetPulumiHomeDir()
				if err != nil {
					return err
				}
				cacheDir = filepath.Join(home, "lint", "sdk-cache")
			}

			tmp, err := os.MkdirTemp("", "pulumi-policy-lint-")
			if err != nil {
				return err
			}
			defer os.RemoveAll(tmp)

			// Pulumi.lint.yaml can name the stack to lint as (`stack: production`), so editors and CI need no flags.
			if !cmd.Flags().Changed("stack") {
				if s := lintFixturesStack(filepath.Dir(projPath), fixturesFile); s != "" {
					stackName = s
				}
			}
			configFile, err := writeLintConfig(tmp, proj, filepath.Dir(projPath), stackName, configOverrides, fixturesFile)
			if err != nil {
				return err
			}

			// Load the packs while the program runs.
			type loaded struct {
				analyzers []plugin.Analyzer
				cleanup   func()
				err       error
				took      time.Duration
			}
			loadCh := make(chan loaded, 1)
			go func() {
				t := time.Now()
				as, cleanup, err := loadLintAnalyzers(ctx,
					engine.MakeLocalPolicyPacks(policyPackPaths, policyPackConfigs))
				loadCh <- loaded{as, cleanup, err, time.Since(t)}
			}()

			scanStart := time.Now()
			graph, err := runLintScan(ctx, cmd.ErrOrStderr(), tmp, lintScanArgs{
				programDir: programDir,
				sdkDir:     sdkDir,
				cacheDir:   cacheDir,
				project:    string(proj.Name),
				stack:      stackName,
				configFile: configFile,
				mainFile:   mainFile,
			})
			scanTook := time.Since(scanStart)
			l := <-loadCh
			if l.cleanup != nil {
				defer l.cleanup()
			}
			if err != nil {
				return err
			}
			if l.err != nil {
				return fmt.Errorf("loading policy packs: %w", l.err)
			}
			if graphOut != "" {
				b, err := json.MarshalIndent(graph, "", " ")
				if err != nil {
					return err
				}
				if err := os.WriteFile(graphOut, b, 0o600); err != nil {
					return err
				}
			}

			analyzeStart := time.Now()
			report, err := analyzeLintGraph(ctx, graph, l.analyzers)
			if err != nil {
				return err
			}
			report.Timings = map[string]int64{
				"scanMs":     scanTook.Milliseconds(),
				"loadPackMs": l.took.Milliseconds(),
				"analyzeMs":  time.Since(analyzeStart).Milliseconds(),
				"totalMs":    time.Since(start).Milliseconds(),
			}
			for k, v := range graph.Timings {
				report.Timings["scan."+k+"Ms"] = v
			}

			if jsonOut {
				enc := json.NewEncoder(cmd.OutOrStdout())
				enc.SetIndent("", "  ")
				if err := enc.Encode(report); err != nil {
					return err
				}
			} else {
				printLintReport(cmd.OutOrStdout(), report)
			}

			for _, f := range report.Findings {
				if f.EnforcementLevel == string(apitype.Mandatory) {
					return errors.New("one or more mandatory policy violations were found")
				}
			}
			if len(report.Errors) > 0 {
				return errors.New("the program failed to load; findings may be incomplete")
			}
			return nil
		},
	}

	cmd.Flags().StringArrayVar(&policyPackPaths, "policy-pack", nil, "Path to a policy pack to run")
	cmd.Flags().StringArrayVar(&policyPackConfigs, "policy-pack-config", nil,
		"Path to a JSON config file for the corresponding --policy-pack")
	cmd.Flags().StringArrayVarP(&configOverrides, "config", "c", nil,
		"Config value to use, as key=value (namespace defaults to the project); overrides the stack's config")
	cmd.Flags().StringVar(&fixturesFile, "fixtures", "",
		"Fixtures file (config, invokes, stackReferences); defaults to Pulumi.lint.yaml next to Pulumi.yaml")
	cmd.Flags().StringVarP(&stackName, "stack", "s", "lint",
		"Stack name to lint as; its Pulumi.<stack>.yaml config is used if present")
	cmd.Flags().BoolVarP(&jsonOut, "json", "j", false, "Emit the findings as JSON")
	cmd.Flags().StringVar(&graphOut, "graph-out", "", "Write the recorded resource graph to this file")
	cmd.Flags().StringVar(&sdkDir, "sdk", "", "Directory of the @pulumi/pulumi package to run the program with")
	cmd.Flags().StringVar(&cacheDir, "sdk-cache", "", "Directory of the shared SDK cache")
	return cmd
}

// defaultLintSDK finds a @pulumi/pulumi with policy output sources: PULUMI_LINT_SDK, or the SDK built next to a
// dev CLI (bin/pulumi → sdk/nodejs/bin).
func defaultLintSDK() string {
	if v := os.Getenv("PULUMI_LINT_SDK"); v != "" {
		return v
	}
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	exe, _ = filepath.EvalSymlinks(exe)
	cand := filepath.Join(filepath.Dir(exe), "..", "sdk", "nodejs", "bin")
	if _, err := os.Stat(filepath.Join(cand, "package.json")); err == nil {
		return cand
	}
	return ""
}

// lintFixturesStack returns the `stack:` named in the fixtures file, if any.
func lintFixturesStack(projectDir, fixturesFile string) string {
	if fixturesFile == "" {
		fixturesFile = filepath.Join(projectDir, "Pulumi.lint.yaml")
	}
	b, err := os.ReadFile(fixturesFile)
	if err != nil {
		return ""
	}
	var doc struct {
		Stack string `yaml:"stack"`
	}
	if yaml.Unmarshal(b, &doc) != nil {
		return ""
	}
	return doc.Stack
}

// lintConfigString renders a config value the way PULUMI_CONFIG carries it: strings as they are, the rest as JSON.
func lintConfigString(v any) (string, error) {
	if s, ok := v.(string); ok {
		return s, nil
	}
	j, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	return string(j), nil
}

// writeLintConfig builds the PULUMI_CONFIG map: the project's config defaults and values, the template's
// defaults, then Pulumi.<stack>.yaml (if any) on top. Secure values can't be decrypted without the stack's
// secrets provider, so they become a placeholder secret. Values still missing are made up by the SDK in lint mode.
func writeLintConfig(
	tmp string, proj *workspace.Project, projectDir, stack string, overrides []string, fixturesFile string,
) (string, error) {
	project := string(proj.Name)
	values := map[string]string{}
	var secretKeys []string
	fullKey := func(k string) string {
		if !strings.Contains(k, ":") {
			return project + ":" + k
		}
		return k
	}
	if proj.Template != nil {
		for k, v := range proj.Template.Config {
			if v.Default != "" {
				values[fullKey(k)] = v.Default
			}
		}
	}
	for k, v := range proj.Config {
		val := v.Value
		if val == nil {
			val = v.Default
		}
		if val == nil {
			continue
		}
		s, err := lintConfigString(val)
		if err != nil {
			return "", err
		}
		values[fullKey(k)] = s
	}
	// Config from a YAML file's `config:` section: plain values, objects as JSON, secure values as a placeholder
	// secret, nulls skipped (unset).
	applyConfigFile := func(path, what string) (map[string]any, error) {
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, nil //nolint:nilerr // a missing file just has no config
		}
		var doc map[string]any
		if err := yaml.Unmarshal(b, &doc); err != nil {
			return nil, fmt.Errorf("reading %s %s: %w", what, path, err)
		}
		cfg, _ := doc["config"].(map[string]any)
		for k, v := range cfg {
			k = fullKey(k)
			if v == nil {
				continue
			}
			if m, ok := v.(map[string]any); ok {
				if _, ok := m["secure"]; ok && len(m) == 1 {
					values[k] = "[secret]"
					secretKeys = append(secretKeys, k)
					continue
				}
			}
			s, err := lintConfigString(v)
			if err != nil {
				return nil, err
			}
			values[k] = s
		}
		return doc, nil
	}
	if _, err := applyConfigFile(filepath.Join(projectDir, "Pulumi."+stack+".yaml"), "stack config"); err != nil {
		return "", err
	}
	// Fixtures (Pulumi.lint.yaml next to Pulumi.yaml, or --fixtures): config the lint run needs, plus results for
	// data sources (`invokes:` by token or function name) and other stacks' outputs (`stackReferences:`).
	if fixturesFile == "" {
		fixturesFile = filepath.Join(projectDir, "Pulumi.lint.yaml")
	}
	fixtureDoc, err := applyConfigFile(fixturesFile, "fixtures")
	if err != nil {
		return "", err
	}
	fixtures := map[string]any{}
	for _, k := range []string{"invokes", "stackReferences"} {
		if v, ok := fixtureDoc[k]; ok && v != nil {
			fixtures[k] = v
		}
	}
	for _, kv := range overrides {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			return "", fmt.Errorf("--config %q: expected key=value", kv)
		}
		values[fullKey(k)] = v
	}
	out := filepath.Join(tmp, "config.json")
	j, err := json.Marshal(map[string]any{"values": values, "secretKeys": secretKeys, "fixtures": fixtures})
	if err != nil {
		return "", err
	}
	return out, os.WriteFile(out, j, 0o600)
}

type lintScanArgs struct {
	programDir, sdkDir, cacheDir, project, stack, configFile, mainFile string
}

func runLintScan(ctx context.Context, stderr io.Writer, tmp string, a lintScanArgs) (*lintGraph, error) {
	script := filepath.Join(tmp, "scan.js")
	if err := os.WriteFile(script, lintScanJS, 0o600); err != nil {
		return nil, err
	}
	out := filepath.Join(tmp, "graph.json")
	node, err := exec.LookPath("node")
	if err != nil {
		return nil, errors.New("policy lint needs node on the PATH")
	}
	// PULUMI_LINT_NODE_ARGS: extra node flags, for debugging (e.g. --prof, --cpu-prof).
	cargs := append(strings.Fields(os.Getenv("PULUMI_LINT_NODE_ARGS")),
		script,
		"--program", a.programDir, "--sdk", a.sdkDir, "--cache", a.cacheDir,
		"--project", a.project, "--stack", a.stack, "--config", a.configFile, "--out", out,
	)
	if a.mainFile != "" {
		cargs = append(cargs, "--main", a.mainFile)
	}
	c := exec.CommandContext(ctx, node, cargs...)
	c.Stdout = stderr
	c.Stderr = stderr
	// The SDK's promise-leak check can turn the exit code to 1 after the driver wrote a partial graph; the graph,
	// with its recorded errors, is what counts.
	runErr := c.Run()
	b, err := os.ReadFile(out)
	if err != nil {
		if runErr != nil {
			return nil, fmt.Errorf("running the program: %w", runErr)
		}
		return nil, fmt.Errorf("reading the recorded graph: %w", err)
	}
	var g lintGraph
	if err := json.Unmarshal(b, &g); err != nil {
		return nil, fmt.Errorf("parsing the recorded graph: %w", err)
	}
	return &g, nil
}

func loadLintAnalyzers(
	ctx context.Context, packs []engine.LocalPolicyPack,
) ([]plugin.Analyzer, func(), error) {
	cwd, err := os.Getwd()
	if err != nil {
		return nil, nil, err
	}
	reg := cmdCmd.NewDefaultRegistry(ctx, cmdBackend.DefaultLoginManager, pkgWorkspace.Instance, nil,
		cmdutil.Diag(), env.Global())
	pluginHost, err := pkghost.New(context.WithoutCancel(ctx), cmdutil.Diag(), cmdutil.Diag(),
		nil, pkgWorkspace.EnsureLanguageInstalled,
		schema.NewLoaderServerFromContext, convert.NewMapperServerFromContext,
		packageworkspace.NewResolverServer(reg))
	if err != nil {
		return nil, nil, fmt.Errorf("creating plugin host: %w", err)
	}
	pctx, err := plugin.NewContext(ctx, cmdutil.Diag(), cmdutil.Diag(), pluginHost, nil, cwd, nil, true, nil)
	if err != nil {
		contract.IgnoreClose(pluginHost)
		return nil, nil, fmt.Errorf("creating plugin context: %w", err)
	}
	cleanup := func() { contract.IgnoreClose(pctx); contract.IgnoreClose(pluginHost) }
	analyzers, err := engine.LoadLocalPolicyPackAnalyzers(ctx, pctx, packs, nil)
	if err != nil {
		cleanup()
		return nil, nil, err
	}
	return analyzers, cleanup, nil
}

func toURNs(ss []string) []resource.URN {
	out := make([]resource.URN, 0, len(ss))
	for _, s := range ss {
		if s != "" {
			out = append(out, resource.URN(s))
		}
	}
	return out
}

// lintStackResources converts the recorded registrations into what AnalyzeStack sees at preview: inputs as the
// program wrote them, unknown inputs tagged with their sources, outputs equal to the inputs (no provider ran),
// and no ID, so `outputs.id` is the resource's identifiable unknown.
func lintStackResources(g *lintGraph) ([]plugin.AnalyzerStackResource, error) {
	var out []plugin.AnalyzerStackResource
	for _, r := range g.Resources {
		obj, err := structpb.NewStruct(r.Object)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", r.URN, err)
		}
		props, err := plugin.UnmarshalProperties(obj, plugin.MarshalOptions{
			Label:         "lint." + r.URN,
			KeepUnknowns:  true,
			KeepSecrets:   true,
			KeepResources: true,
		})
		if err != nil {
			return nil, fmt.Errorf("%s: %w", r.URN, err)
		}
		pdeps := map[resource.PropertyKey][]resource.URN{}
		for k, v := range r.PropertyDependencies {
			pdeps[resource.PropertyKey(k)] = toURNs(v)
		}
		inputs := resource.FromResourcePropertyMap(props)
		res := plugin.AnalyzerStackResource{
			AnalyzerResource: plugin.AnalyzerResource{
				URN:        resource.URN(r.URN),
				Type:       resource.URN(r.URN).Type(),
				Name:       r.Name,
				Properties: inputs,
				Options: plugin.AnalyzerResourceOptions{
					Parent: resource.URN(r.Parent),
				},
			},
			Parent:               resource.URN(r.Parent),
			Dependencies:         toURNs(r.Dependencies),
			PropertyDependencies: pdeps,
			Inputs:               inputs,
			ID:                   resource.ID(r.ID),
			UnknownInputs:        deploy.CollectOutputSources(obj),
		}
		out = append(out, res)
	}

	// No provider ran, so outputs that aren't inputs are missing. Every output another resource reads exists,
	// though, so give it its identifiable unknown on the resource it comes from: `alb.arn` read by an association
	// is `outputs.arn` on the ALB, the same opaque value on both sides.
	index := map[resource.URN]int{}
	for i, r := range out {
		index[r.URN] = i
	}
	var mark func(srcs map[string]plugin.OutputSource)
	mark = func(srcs map[string]plugin.OutputSource) {
		for _, s := range srcs {
			if s.Template != nil {
				mark(s.Template.Unknowns)
			}
			if s.URN == "" || s.Property == "" || s.Property == "id" || s.Property == "urn" {
				continue
			}
			i, ok := index[s.URN]
			if !ok {
				continue
			}
			if _, has := out[i].Properties.GetOk(s.Property); !has {
				out[i].Properties = out[i].Properties.Set(s.Property, property.New(property.Computed))
			}
		}
	}
	for _, r := range out {
		mark(r.UnknownInputs)
	}
	return out, nil
}

func analyzeLintGraph(
	ctx context.Context, g *lintGraph, analyzers []plugin.Analyzer,
) (*lintReport, error) {
	resources, err := lintStackResources(g)
	if err != nil {
		return nil, err
	}
	byURN := map[string]lintResource{}
	for _, r := range g.Resources {
		byURN[r.URN] = r
	}
	stackURN := ""
	for _, r := range g.Resources {
		if r.Type == "pulumi:pulumi:Stack" {
			stackURN = r.URN
		}
	}

	report := &lintReport{
		Project:    g.Project,
		ProgramDir: g.ProgramDir,
		Resources:  len(g.Resources),
		Findings:   []LintFinding{},
		Advisories: []LintFinding{},
		Stubs:      g.Stubs,
		Missing:    g.Missing,
		Assumed:    g.Assumed,
		Network:    g.Network,
		Fixtures:   g.Fixtures,
		Unmocked:   g.Unmocked,
		Probed:     g.Probed,
		Failed:     g.Failed,
	}
	for _, e := range g.Errors {
		report.Errors = append(report.Errors, e.Message)
	}

	add := func(d plugin.AnalyzeDiagnostic, urn string) {
		if urn == "" {
			urn = stackURN
		}
		r := byURN[urn]
		f := LintFinding{
			URN:              urn,
			Type:             r.Type,
			Name:             r.Name,
			PolicyPack:       d.PolicyPackName,
			PolicyPackVer:    d.PolicyPackVersion,
			Policy:           d.PolicyName,
			Description:      d.Description,
			Severity:         string(d.Severity),
			EnforcementLevel: string(d.EnforcementLevel),
			Message:          strings.TrimSpace(d.Message),
		}
		// Positions outside the program (the Stack resource is registered by the SDK) aren't useful.
		if p := r.SourcePosition; p != nil {
			if u, err := url.Parse(p.URI); err == nil && u.Scheme == "file" {
				root := g.CodeRoot
				if root == "" {
					root = g.ProgramDir
				}
				if rel, err := filepath.Rel(root, u.Path); err == nil && !strings.HasPrefix(rel, "..") &&
					!strings.Contains(rel, "node_modules") {
					f.URI, f.Line, f.Column, f.File = p.URI, p.Line, p.Column, rel
				}
			}
		}
		if strings.HasPrefix(f.Message, "can't run policy") || strings.Contains(f.Message, "reads the contents of an output") {
			report.Advisories = append(report.Advisories, f)
		} else {
			report.Findings = append(report.Findings, f)
		}
	}

	for _, a := range analyzers {
		resp, err := a.AnalyzeStack(ctx, resources)
		if err != nil {
			return nil, err
		}
		for _, d := range resp.Diagnostics {
			add(d, string(d.URN))
		}
		// Per-resource (v1) policies see each resource's inputs, as in preview.
		for _, r := range resources {
			if r.Type == "pulumi:pulumi:Stack" {
				continue
			}
			resp, err := a.Analyze(ctx, r.AnalyzerResource)
			if err != nil {
				return nil, err
			}
			for _, d := range resp.Diagnostics {
				add(d, string(r.URN))
			}
		}
	}

	sortFindings := func(fs []LintFinding) {
		sort.SliceStable(fs, func(i, j int) bool {
			if fs[i].File != fs[j].File {
				return fs[i].File < fs[j].File
			}
			if fs[i].Line != fs[j].Line {
				return fs[i].Line < fs[j].Line
			}
			return fs[i].Policy < fs[j].Policy
		})
	}
	sortFindings(report.Findings)
	sortFindings(report.Advisories)
	return report, nil
}

func printLintReport(w io.Writer, r *lintReport) {
	loc := func(f LintFinding) string {
		if f.File == "" {
			return "(no source position)"
		}
		return fmt.Sprintf("%s:%d:%d", f.File, f.Line, f.Column)
	}
	print := func(fs []LintFinding) {
		last := ""
		for _, f := range fs {
			head := fmt.Sprintf("%s  %s %s", loc(f), f.Type, f.Name)
			if head != last {
				fmt.Fprintf(w, "\n%s\n", head)
				last = head
			}
			fmt.Fprintf(w, "  %-9s %s/%s: %s\n", f.EnforcementLevel, f.PolicyPack, f.Policy,
				strings.ReplaceAll(f.Message, "\n", "\n            "))
		}
	}

	fmt.Fprintf(w, "Policy lint of %s (%s): %d resources\n", r.Project, r.ProgramDir, r.Resources)
	print(r.Findings)
	if len(r.Advisories) > 0 {
		fmt.Fprintf(w, "\nPolicies that couldn't fully run before deployment:\n")
		print(r.Advisories)
	}
	if len(r.Stubs) > 0 {
		fmt.Fprintf(w, "\nModules not available, replaced by stubs: %s\n", strings.Join(r.Stubs, ", "))
	}
	if r.Probed > 0 || r.Failed > 0 {
		fmt.Fprintf(w, "\napply callbacks run on unknown values with probes: %d (%d fell back to unknown)\n", r.Probed, r.Failed)
	}
	if len(r.Network) > 0 {
		fmt.Fprintf(w, "\nSide effects blocked (network, processes; results are unknown or empty): %s\n", strings.Join(r.Network, ", "))
	}
	if len(r.Fixtures) > 0 {
		fmt.Fprintf(w, "\nFixtures used: %s\n", strings.Join(r.Fixtures, ", "))
	}
	if len(r.Unmocked) > 0 {
		fmt.Fprintf(w, "\nUnknown without a fixture (add to Pulumi.lint.yaml to make them known): %s\n",
			strings.Join(r.Unmocked, ", "))
	}
	if len(r.Assumed) > 0 {
		fmt.Fprintf(w, "\nBuild outputs not present, assumed built: %s\n", strings.Join(r.Assumed, ", "))
	}
	if len(r.Missing) > 0 {
		fmt.Fprintf(w, "\nConfig not set, placeholders used: %s\n", strings.Join(r.Missing, ", "))
	}
	for _, e := range r.Errors {
		fmt.Fprintf(w, "\nerror: %s\n", e)
	}
	mandatory, advisory := 0, 0
	for _, f := range r.Findings {
		if f.EnforcementLevel == string(apitype.Mandatory) {
			mandatory++
		} else {
			advisory++
		}
	}
	fmt.Fprintf(w, "\n%d mandatory, %d advisory violations; %d policy results couldn't be decided before deployment (%dms)\n",
		mandatory, advisory, len(r.Advisories), r.Timings["totalMs"])
}
