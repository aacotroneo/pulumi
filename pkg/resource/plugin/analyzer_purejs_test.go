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
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/pulumi/pulumi/sdk/v3/go/common/workspace"
	"github.com/pulumi/pulumi/sdk/v3/go/property"
)

const testPureJSPack = `
globalThis.__pulumiPolicyPack = {
  abiVersion: 1,
  name: "test-pack",
  version: "0.0.1",
  policies: [
    {
      name: "bucket-versioning",
      description: "Buckets must be versioned.",
      severity: "high",
      enforcementLevel: "mandatory",
      kind: "resource",
      resourceTypes: ["aws:s3/bucket:Bucket"],
      validate: function (input, ctx) {
        if (!input.props.versioning || !input.props.versioning.enabled) {
          ctx.reportViolation("versioning is off for " + input.name);
        }
      },
    },
    {
      name: "name-length",
      description: "Names must be short.",
      configSchema: { properties: { max: { type: "integer", default: 5 } } },
      kind: "resource",
      validate: function (input, ctx) {
        var max = input.config.max === undefined ? 100 : input.config.max;
        if (input.name.length > max) ctx.reportViolation("too long");
      },
    },
    {
      name: "only-buckets",
      description: "NA test",
      kind: "resource",
      validate: function (input, ctx) {
        if (input.type !== "aws:s3/bucket:Bucket") ctx.notApplicable("not a bucket");
      },
    },
    {
      name: "reads-arn",
      description: "Reads an unknown.",
      kind: "resource",
      resourceTypes: ["aws:s3/bucket:Bucket"],
      validate: function (input, ctx) {
        ctx.reportViolation("before");
        if (input.props.arn.indexOf("x") >= 0) ctx.reportViolation("after");
      },
    },
    {
      name: "secret-and-prelude",
      description: "Prelude test.",
      kind: "resource",
      resourceTypes: ["aws:ec2/instance:Instance"],
      validate: function (input, ctx) {
        var ud = Buffer.from(input.props.userDataBase64, "base64").toString("utf8");
        if (ud.indexOf("AKIA") >= 0) ctx.reportViolation("secret in user data");
        if (atob(btoa("hi")) !== "hi") ctx.reportViolation("atob broken");
        var u = new URL(input.props.repo);
        if (u.hostname !== "github.com" || u.protocol !== "https:") ctx.reportViolation("bad url " + u.hostname);
        if (!/(?<!a)b/.test("cb")) ctx.reportViolation("lookbehind broken");
        if (input.props.password !== "hunter2") ctx.reportViolation("secret not unwrapped");
        console.warn("hello", { a: 1 });
      },
    },
    {
      name: "object-violation",
      description: "Object form.",
      kind: "resource",
      resourceTypes: ["aws:ec2/instance:Instance"],
      validate: function (input, ctx) {
        ctx.reportViolation({ message: "custom", severity: "low", urn: "urn:custom" });
      },
    },
    {
      name: "stack-deps",
      description: "Stack policy.",
      kind: "stack",
      validate: function (input, ctx) {
        input.resources.forEach(function (r) {
          if (r.parent) {
            ctx.reportViolation(r.name + " parent=" + r.parent + " deps=" + r.dependencies.join(","), r.urn);
          }
        });
      },
    },
    {
      name: "stack-typed",
      description: "Only when there are queues.",
      kind: "stack",
      resourceTypes: ["aws:sqs/queue:Queue"],
      validate: function (input, ctx) { ctx.reportViolation("queues!"); },
    },
    {
      name: "throws",
      description: "Throws.",
      kind: "resource",
      resourceTypes: ["test:index:Boom"],
      validate: function () { throw new Error("boom"); },
    },
  ],
};
`

func newTestJSAnalyzer(t testing.TB, src string) *jsAnalyzer {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "policies.js"), []byte(src), 0o600))
	desc := "yaml description"
	proj := &workspace.PolicyPackProject{Main: "policies.js", Version: "1.2.3", Description: &desc}
	a, err := newJSAnalyzer("test", dir, proj)
	require.NoError(t, err)
	return a.(*jsAnalyzer)
}

func bucket(name string, props map[string]property.Value) AnalyzerResource {
	return AnalyzerResource{
		URN:        "urn:pulumi:dev::proj::aws:s3/bucket:Bucket::" + "b",
		Type:       "aws:s3/bucket:Bucket",
		Name:       name,
		Properties: property.NewMap(props),
	}
}

func TestPureJSAnalyzerInfo(t *testing.T) {
	t.Parallel()
	a := newTestJSAnalyzer(t, testPureJSPack)
	info, err := a.GetAnalyzerInfo(t.Context())
	require.NoError(t, err)
	assert.Equal(t, "test-pack", info.Name)
	assert.Equal(t, "1.2.3", info.Version, "PulumiPolicy.yaml version wins")
	assert.Equal(t, "yaml description", info.Description)
	assert.True(t, info.SupportsConfig)
	require.Len(t, info.Policies, 9)
	assert.Equal(t, "bucket-versioning", info.Policies[0].Name, "sorted by name")
	assert.Equal(t, apitype.Mandatory, info.Policies[0].EnforcementLevel)
	assert.Equal(t, apitype.PolicySeverityHigh, info.Policies[0].Severity)
	assert.Contains(t, info.Policies[0].ConfigSchema.Properties, "enforcementLevel")
	for _, p := range info.Policies {
		if p.Name == "name-length" {
			assert.Equal(t, apitype.Advisory, p.EnforcementLevel, "defaults to advisory")
			assert.Contains(t, p.ConfigSchema.Properties, "max")
		}
		if strings.HasPrefix(p.Name, "stack-") {
			assert.Equal(t, AnalyzerPolicyTypeStack, p.Type)
		}
	}
}

func TestPureJSAnalyzerAnalyze(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	a := newTestJSAnalyzer(t, testPureJSPack)

	resp, err := a.Analyze(ctx, bucket("my-bucket", map[string]property.Value{
		"arn": property.New(property.Computed),
	}))
	require.NoError(t, err)

	byPolicy := map[string][]AnalyzeDiagnostic{}
	for _, d := range resp.Diagnostics {
		byPolicy[d.PolicyName] = append(byPolicy[d.PolicyName], d)
	}
	require.Len(t, byPolicy["bucket-versioning"], 1)
	d := byPolicy["bucket-versioning"][0]
	assert.Equal(t, "Buckets must be versioned.\nversioning is off for my-bucket", d.Message)
	assert.Equal(t, apitype.Mandatory, d.EnforcementLevel)
	assert.Equal(t, "test-pack", d.PolicyPackName)
	assert.Equal(t, "1.2.3", d.PolicyPackVersion)
	assert.Equal(t, apitype.PolicySeverityHigh, d.Severity)

	// name-length has no config yet, so the fallback max (100) applies.
	assert.Empty(t, byPolicy["name-length"])

	// The unknown read keeps the earlier violation and adds an advisory "can't run" diagnostic.
	require.Len(t, byPolicy["reads-arn"], 2)
	assert.Equal(t, "Reads an unknown.\nbefore", byPolicy["reads-arn"][0].Message)
	assert.Equal(t,
		"can't run policy 'reads-arn' from policy pack 'test-pack@v1.2.3' during preview: "+
			"string value at .arn can't be known during preview",
		byPolicy["reads-arn"][1].Message)
	assert.Equal(t, apitype.Advisory, byPolicy["reads-arn"][1].EnforcementLevel)

	na := map[string]string{}
	for _, n := range resp.NotApplicable {
		na[n.PolicyName] = n.Reason
	}
	assert.Equal(t, "Policy only applies to resources of type 'aws:ec2/instance:Instance'", na["secret-and-prelude"])
	assert.NotContains(t, na, "only-buckets")

	resp, err = a.Analyze(ctx, AnalyzerResource{URN: "urn:x", Type: "aws:sqs/queue:Queue", Name: "q"})
	require.NoError(t, err)
	na = map[string]string{}
	for _, n := range resp.NotApplicable {
		na[n.PolicyName] = n.Reason
	}
	assert.Equal(t, "not a bucket", na["only-buckets"])
}

func TestPureJSAnalyzerConfigure(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	a := newTestJSAnalyzer(t, testPureJSPack)
	require.NoError(t, a.Configure(ctx, map[string]AnalyzerPolicyConfig{
		"bucket-versioning": {EnforcementLevel: apitype.Remediate},
		"name-length":       {EnforcementLevel: apitype.Mandatory, Properties: map[string]any{"max": 3}},
		"reads-arn":         {EnforcementLevel: apitype.Disabled},
	}))

	resp, err := a.Analyze(ctx, bucket("long-name", map[string]property.Value{
		"arn":        property.New("x"),
		"versioning": property.New(map[string]property.Value{"enabled": property.New(true)}),
	}))
	require.NoError(t, err)
	names := map[string]AnalyzeDiagnostic{}
	for _, d := range resp.Diagnostics {
		names[d.PolicyName] = d
	}
	assert.NotContains(t, names, "reads-arn", "disabled policies don't run")
	assert.NotContains(t, names, "bucket-versioning")
	require.Contains(t, names, "name-length")
	assert.Equal(t, apitype.Mandatory, names["name-length"].EnforcementLevel)

	resp, err = a.Analyze(ctx, bucket("b", map[string]property.Value{}))
	require.NoError(t, err)
	require.Len(t, resp.Diagnostics, 1)
	assert.Equal(t, apitype.Mandatory, resp.Diagnostics[0].EnforcementLevel, "remediate is reported as mandatory")

	info, err := a.GetAnalyzerInfo(ctx)
	require.NoError(t, err)
	for _, p := range info.Policies {
		if p.Name == "reads-arn" {
			assert.Equal(t, apitype.Disabled, p.EnforcementLevel)
		}
	}
}

func TestPureJSAnalyzerPreludeAndObjectViolations(t *testing.T) {
	t.Parallel()
	a := newTestJSAnalyzer(t, testPureJSPack)
	resp, err := a.Analyze(t.Context(), AnalyzerResource{
		URN:  "urn:pulumi:dev::proj::aws:ec2/instance:Instance::i",
		Type: "aws:ec2/instance:Instance",
		Name: "i",
		Properties: property.NewMap(map[string]property.Value{
			"userDataBase64": property.New("ZXhwb3J0IEtFWT1BS0lBMTIz"), // "export KEY=AKIA123"
			"repo":           property.New("https://github.com/pulumi/pulumi.git"),
			"password":       property.New("hunter2").WithSecret(true),
		}),
	})
	require.NoError(t, err)
	msgs := make([]string, 0, len(resp.Diagnostics))
	for _, d := range resp.Diagnostics {
		msgs = append(msgs, d.PolicyName+": "+d.Message)
		if d.PolicyName == "object-violation" {
			assert.Equal(t, "custom", d.Message)
			assert.Equal(t, apitype.PolicySeverityLow, d.Severity)
			assert.Equal(t, "urn:custom", string(d.URN))
		}
	}
	assert.ElementsMatch(t, []string{
		"secret-and-prelude: Prelude test.\nsecret in user data",
		"object-violation: custom",
	}, msgs)
}

func TestPureJSAnalyzerStack(t *testing.T) {
	t.Parallel()
	a := newTestJSAnalyzer(t, testPureJSPack)
	parent := AnalyzerStackResource{AnalyzerResource: AnalyzerResource{URN: "urn:p", Type: "pkg:index:Comp", Name: "p"}}
	child := AnalyzerStackResource{
		AnalyzerResource: AnalyzerResource{URN: "urn:c", Type: "aws:s3/bucket:Bucket", Name: "c"},
		Parent:           "urn:p",
		Dependencies:     []resource.URN{"urn:p"},
	}
	resp, err := a.AnalyzeStack(t.Context(), []AnalyzerStackResource{parent, child})
	require.NoError(t, err)
	require.Len(t, resp.Diagnostics, 1)
	assert.Equal(t, "Stack policy.\nc parent=urn:p deps=urn:p", resp.Diagnostics[0].Message)
	assert.Equal(t, "urn:c", string(resp.Diagnostics[0].URN))
	require.Len(t, resp.NotApplicable, 1)
	assert.Equal(t, "stack-typed", resp.NotApplicable[0].PolicyName)
}

func TestPureJSAnalyzerErrors(t *testing.T) {
	t.Parallel()
	a := newTestJSAnalyzer(t, testPureJSPack)
	_, err := a.Analyze(t.Context(), AnalyzerResource{URN: "urn:x", Type: "test:index:Boom", Name: "x"})
	require.ErrorContains(t, err, "Error validating resource with policy 'throws' from policy pack 'test-pack@v1.2.3'")
	require.ErrorContains(t, err, "boom")

	bad := newTestJSAnalyzer(t, `var x = 1;`)
	_, err = bad.GetAnalyzerInfo(t.Context())
	require.ErrorContains(t, err, "did not set globalThis.__pulumiPolicyPack")
}

func TestPureJSAnalyzerConcurrent(t *testing.T) {
	t.Parallel()
	a := newTestJSAnalyzer(t, testPureJSPack)
	var wg sync.WaitGroup
	for i := range 8 {
		wg.Go(func() {
			for range 20 {
				_, err := a.Analyze(t.Context(), bucket(fmt.Sprintf("b%d", i), map[string]property.Value{
					"arn": property.New("arn:x"),
				}))
				assert.NoError(t, err) //nolint:forbidigo // require must not be called from a goroutine
			}
		})
	}
	wg.Wait()
}

// genPureJSPack builds a synthetic bundle with n policies, each carrying some metadata text, to size goja's cost.
func genPureJSPack(n int) string {
	var b strings.Builder
	b.WriteString("globalThis.__pulumiPolicyPack = { abiVersion: 1, name: \"bench\", version: \"1.0.0\", policies: [\n")
	for i := range n {
		fmt.Fprintf(&b, `{ name: "policy-%d", description: "Policy %d %s", remediationSteps: %q, kind: "resource",
  resourceTypes: ["aws:s3/bucket:Bucket"],
  validate: function (input, ctx) {
    var p = input.props, cfg = input.config;
    var tags = p.tags || {};
    if (!tags.owner && !(cfg.exempt || []).some(function (e) { return new RegExp(e).test(input.name); })) {
      ctx.reportViolation("missing owner tag on " + input.name + " (" + %d + ")");
    }
  } },
`, i, i, strings.Repeat("lorem ipsum ", 20), strings.Repeat("Step one. Step two. ", 30), i)
	}
	b.WriteString("] };\n")
	return b.String()
}

func BenchmarkPureJSLoad(b *testing.B) {
	src := genPureJSPack(400)
	b.ReportMetric(float64(len(src))/1024, "KB")
	for b.Loop() {
		a := newTestJSAnalyzer(b, src)
		_, err := a.GetAnalyzerInfo(b.Context())
		require.NoError(b, err)
	}
}

func BenchmarkPureJSAnalyze(b *testing.B) {
	a := newTestJSAnalyzer(b, genPureJSPack(400))
	r := bucket("my-bucket", map[string]property.Value{
		"tags": property.New(map[string]property.Value{"env": property.New("dev")}),
		"acl":  property.New("private"),
	})
	for b.Loop() {
		_, err := a.Analyze(b.Context(), r)
		require.NoError(b, err)
	}
}
