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
	"encoding/json"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/pulumi/pulumi/sdk/v3/go/common/tokens"
	"github.com/pulumi/pulumi/sdk/v3/go/property"
)

const testInputPack = `
function report(ctx, msg) { ctx.reportViolation(msg); }
function find(resources, type, value) {
  return resources.find(function (r) {
    return r.type === type && (r.outputs.id === value || r.outputs.arn === value);
  });
}
var EFS = ["aws:efs/fileSystem:FileSystem"];
globalThis.__pulumiPolicyPack = {
  abiVersion: 2,
  name: "input-pack",
  version: "0.0.1",
  enforcementLevel: "mandatory",
  policies: [
    { name: "pab-linked", description: "PABs link to buckets.",
      validate: function (input, ctx) {
        var rs = input.resources;
        var PAB = "aws:s3/bucketPublicAccessBlock:BucketPublicAccessBlock";
        var pabs = rs.filter(function (r) { return r.type === PAB; });
        rs.filter(function (r) { return r.type === "aws:s3/bucket:Bucket"; }).forEach(function (b) {
          var byFind = pabs.find(function (p) { return p.inputs.bucket === b.outputs.id; });
          var bySet = new Set(pabs.map(function (p) { return p.inputs.bucket; })).has(b.outputs.id);
          var byIncludes = pabs.map(function (p) { return p.inputs.bucket; }).includes(b.outputs.id);
          var byMap = {}; pabs.forEach(function (p) { byMap[p.inputs.bucket] = p; });
          var byName = pabs.find(function (p) { return p.inputs.bucket === b.inputs.bucket; });
          ctx.reportViolation("bucket " + b.name + " find=" + !!byFind + " set=" + bySet + " includes=" + byIncludes +
            " map=" + !!byMap[b.outputs.id] + " byName=" + !!byName +
            ` + "` pab.bucket=${pabs[0].inputs.bucket}`" + `, b.urn);
        });
      } },
    { name: "efs-key", resourceTypes: EFS, description: "EFS is linked to its key.",
      validate: function (input, ctx) {
        var ref = input.resource.inputs.kmsKeyId;
        var key = find(input.resources, "aws:kms/key:Key", ref);
        report(ctx, "key=" + (key ? key.name : "none") + " arnEq=" + (key && key.outputs.arn === ref) +
          " idEq=" + (key && key.outputs.id === ref) + " typeof=" + typeof ref + ` + "` kms=${ref}`" + `);
      } },
    { name: "reads-content", resourceTypes: EFS, description: "Parses an ARN.",
      validate: function (input, ctx) {
        report(ctx, "before");
        if (!input.resource.inputs.kmsKeyId.startsWith("arn:aws:kms:")) report(ctx, "not a kms arn");
      } },
    { name: "reads-prop", resourceTypes: ["aws:ec2/instance:Instance"], description: "Reads into an output.",
      validate: function (input, ctx) {
        var r = input.resource;
        report(ctx, "metadataOptions=" + typeof r.inputs.metadataOptions + " outputHttpTokens=" +
          r.outputs.metadataOptions.httpTokens + " publicIpEqArn=" + (r.outputs.publicIp === r.outputs.arn));
        if (r.outputs.publicIp.address) report(ctx, "unreachable");
      } },
    { name: "subnets", resourceTypes: ["aws:lb/loadBalancer:LoadBalancer"], description: "Two pending subnets.",
      validate: function (input, ctx) {
        var names = input.resource.inputs.subnets.map(function (id) {
          var s = find(input.resources, "aws:ec2/subnet:Subnet", id);
          return s ? s.name : "none";
        });
        report(ctx, "subnets=" + names.join(","));
      } },
    { name: "derived", resourceTypes: ["aws:iam/policy:Policy"], description: "Reads a document built from an output.",
      validate: function (input, ctx) { JSON.parse(input.resource.inputs.policy); } },
    { name: "swallows", resourceTypes: EFS, description: "Catches the error and reports a verdict anyway.",
      validate: function (input, ctx) {
        report(ctx, "before");
        try { JSON.parse(input.resource.inputs.kmsKeyId); } catch (e) { report(ctx, "invalid json"); }
      } },
    { name: "regex", resourceTypes: EFS, description: "Regex on a ref.",
      validate: function (input, ctx) { /^arn:/.test(input.resource.inputs.kmsKeyId); } },
    { name: "not-here", resourceTypes: ["aws:rds/instance:Instance"], description: "No such resource.",
      validate: function (input, ctx) { ctx.reportPass(); } },
    { name: "encrypted", resourceTypes: EFS, description: "Explicit passes.",
      validate: function (input, ctx) {
        if (input.resource.inputs.encrypted === true) ctx.reportPass(); else ctx.reportViolation("not encrypted");
      } },
    { name: "known-key", resourceTypes: EFS, description: "A pass on one resource, a violation on another.",
      validate: function (input, ctx) {
        if (find(input.resources, "aws:kms/key:Key", input.resource.inputs.kmsKeyId).name === "key") ctx.reportPass();
        else ctx.reportViolation("new key");
      } },
    { name: "silent", description: "Reports nothing.", validate: function () {} },
    { name: "silent-typed", resourceTypes: EFS, description: "Reports nothing either.", validate: function () {} },
    { name: "every", resourceTypes: ["*"], description: "Runs on every resource.",
      validate: function (input, ctx) { report(ctx, input.resource.type); } },
    { name: "no-na", resourceTypes: EFS, description: "ABI v2 has no notApplicable.",
      validate: function (input, ctx) { report(ctx, "keys=" + Object.keys(ctx).sort().join(",")); } },
  ],
};
`

func stackRes(
	urn, typ string, id resource.ID, inputs, outputs map[string]property.Value, pdeps map[string][]string,
) AnalyzerStackResource {
	r := AnalyzerStackResource{
		AnalyzerResource: AnalyzerResource{
			URN: resource.URN(urn), Type: tokens.Type(typ), Name: urn[strings.LastIndex(urn, ":")+1:],
			Properties: property.NewMap(outputs),
		},
		Inputs: property.NewMap(inputs),
		ID:     id,
	}
	if len(pdeps) > 0 {
		r.PropertyDependencies = map[resource.PropertyKey][]resource.URN{}
		for k, us := range pdeps {
			for _, u := range us {
				r.PropertyDependencies[resource.PropertyKey(k)] = append(r.PropertyDependencies[resource.PropertyKey(k)],
					resource.URN(u))
				r.Dependencies = append(r.Dependencies, resource.URN(u))
			}
		}
	}
	return r
}

// linkedStack is a preview of a stack with existing and new resources linked through their outputs. With sourced,
// the program's SDK reported which output each unknown input is.
func linkedStack(sourced bool) []AnalyzerStackResource {
	unk := property.New(property.Computed)
	s := func(v any) property.Value {
		switch v := v.(type) {
		case string:
			return property.New(v)
		case bool:
			return property.New(v)
		case property.Map:
			return property.New(v)
		case property.Array:
			return property.New(v)
		}
		panic(v)
	}
	const keyArn = "arn:aws:kms:us-west-2:123456789012:key/1111-2222"
	rs := []AnalyzerStackResource{
		// A new bucket and its public access block: the link is unknown during preview.
		stackRes("urn:x::good", "aws:s3/bucket:Bucket", "",
			map[string]property.Value{"bucket": s("good-123abc")},
			map[string]property.Value{"bucket": s("good-123abc"), "id": unk, "arn": unk}, nil),
		stackRes("urn:x::pab", "aws:s3/bucketPublicAccessBlock:BucketPublicAccessBlock", "",
			map[string]property.Value{"bucket": unk, "blockPublicAcls": s(true)},
			map[string]property.Value{"bucket": unk, "id": unk}, map[string][]string{"bucket": {"urn:x::good"}}),
		// An existing key and a file system that references it: the link is a known ARN.
		stackRes("urn:x::key", "aws:kms/key:Key", "1111-2222",
			map[string]property.Value{"description": s("k")},
			map[string]property.Value{"id": s("1111-2222"), "arn": s(keyArn), "keyId": s("1111-2222")}, nil),
		stackRes("urn:x::efs", "aws:efs/fileSystem:FileSystem", "fs-1",
			map[string]property.Value{"kmsKeyId": s(keyArn), "encrypted": s(true)},
			map[string]property.Value{"kmsKeyId": s(keyArn), "id": s("fs-1")}, map[string][]string{"kmsKeyId": {"urn:x::key"}}),
		// A new key and a file system that references its ARN, and a document derived from that ARN.
		stackRes("urn:x::key2", "aws:kms/key:Key", "",
			map[string]property.Value{"description": s("k2")},
			map[string]property.Value{"id": unk, "arn": unk, "keyId": unk}, nil),
		stackRes("urn:x::efs2", "aws:efs/fileSystem:FileSystem", "",
			map[string]property.Value{"kmsKeyId": unk, "encrypted": s(true)},
			map[string]property.Value{"kmsKeyId": unk, "id": unk}, map[string][]string{"kmsKeyId": {"urn:x::key2"}}),
		stackRes("urn:x::doc", "aws:iam/policy:Policy", "",
			map[string]property.Value{"policy": unk},
			map[string]property.Value{"id": unk}, map[string][]string{"policy": {"urn:x::key2"}}),
		// An instance whose metadataOptions was never written: it must stay absent.
		stackRes("urn:x::inst", "aws:ec2/instance:Instance", "",
			map[string]property.Value{"ami": s("ami-1")},
			map[string]property.Value{
				"arn": unk, "publicIp": unk,
				"metadataOptions": s(property.NewMap(map[string]property.Value{"httpTokens": s("optional")})),
			}, nil),
		// Two pending subnets feeding one list.
		stackRes("urn:x::s1", "aws:ec2/subnet:Subnet", "", nil, map[string]property.Value{"id": unk}, nil),
		stackRes("urn:x::s2", "aws:ec2/subnet:Subnet", "", nil, map[string]property.Value{"id": unk}, nil),
		stackRes("urn:x::alb", "aws:lb/loadBalancer:LoadBalancer", "",
			map[string]property.Value{"subnets": s(property.NewArray([]property.Value{unk, unk}))},
			map[string]property.Value{"id": unk}, map[string][]string{"subnets": {"urn:x::s1", "urn:x::s2"}}),
	}
	if sourced {
		sources := map[resource.URN]map[string]OutputSource{
			"urn:x::pab":  {"bucket": {URN: "urn:x::good", Property: "id"}},
			"urn:x::efs2": {"kmsKeyId": {URN: "urn:x::key2", Property: "arn"}},
			"urn:x::doc":  {"policy": {Dependencies: []resource.URN{"urn:x::key2"}}},
			"urn:x::alb": {
				"subnets.0": {URN: "urn:x::s1", Property: "id"},
				"subnets.1": {URN: "urn:x::s2", Property: "id"},
			},
		}
		for i := range rs {
			rs[i].UnknownInputs = sources[rs[i].URN]
		}
	}
	return rs
}

func TestPureJSInputPolicies(t *testing.T) {
	t.Parallel()
	a := newTestJSAnalyzer(t, testInputPack)

	info, err := a.GetAnalyzerInfo(t.Context())
	require.NoError(t, err)
	for _, p := range info.Policies {
		assert.Equal(t, AnalyzerPolicyTypeStack, p.Type, p.Name)
	}

	// v2 policies never run per resource in Analyze.
	resp, err := a.Analyze(t.Context(), AnalyzerResource{URN: "urn:x::efs", Type: "aws:efs/fileSystem:FileSystem"})
	require.NoError(t, err)
	assert.Empty(t, resp.Diagnostics)

	resp, err = a.AnalyzeStack(t.Context(), linkedStack(true))
	require.NoError(t, err)
	got, levels := byPolicy(resp)

	// A PAB written as `bucket: good.id` holds the bucket's id: joins on the id find it through every equality idiom,
	// while a join on the name doesn't (the name is known, the id isn't yet). Messages show the output an identifiable
	// unknown stands for.
	assert.Equal(t, []string{
		"urn:x::good | bucket good find=true set=true includes=true map=true byName=false pab.bucket=<output good.id>",
	}, got["pab-linked"])
	// Known values stay real: the existing key is found by its ARN. The new key's ARN is an identifiable unknown, the
	// same object as the key's own outputs.arn and different from its id.
	assert.Equal(t, []string{
		"urn:x::efs | key=key arnEq=true idEq=false typeof=string kms=arn:aws:kms:us-west-2:123456789012:key/1111-2222",
		"urn:x::efs2 | key=key2 arnEq=true idEq=false typeof=object kms=<output key2.arn>",
	}, got["efs-key"])
	// Reading into an identifiable unknown is flagged (advisory), after keeping the violations reported before it.
	// The known ARN can be read.
	require.Len(t, got["reads-content"], 3)
	assert.Equal(t, "urn:x::efs | before", got["reads-content"][0])
	assert.Equal(t, "urn:x::efs2 | before", got["reads-content"][1])
	assert.Contains(t, got["reads-content"][2], ".startsWith on the output 'arn' of aws:kms/key:Key 'key2'")
	assert.Contains(t, got["reads-content"][2], "reads the contents of an output")
	// A policy that catches the error keeps what it reported before reading the output, and the rest is replaced by
	// the advisory. A real parse error on a known value is the policy's own business.
	require.Len(t, got["swallows"], 4)
	assert.Equal(t, []string{"urn:x::efs | before", "urn:x::efs | invalid json", "urn:x::efs2 | before"},
		got["swallows"][:3])
	assert.Contains(t, got["swallows"][3], "JSON.parse() on the output 'arn' of aws:kms/key:Key 'key2'")
	assert.Equal(t, []string{"urn:x::efs2"}, urnsOf(got["regex"]))
	assert.Contains(t, got["regex"][0], "RegExp.test() on the output 'arn' of aws:kms/key:Key 'key2'")
	// Inputs and outputs are separate: an input the program didn't set is absent from inputs even though the provider
	// planned a value for it. Known outputs are real; unknown ones are the resource's own identifiable unknowns, and
	// reading into them is flagged.
	require.Len(t, got["reads-prop"], 2)
	assert.Equal(t, "urn:x::inst | metadataOptions=undefined outputHttpTokens=optional publicIpEqArn=false",
		got["reads-prop"][0])
	assert.Contains(t, got["reads-prop"][1], ".address on the output 'publicIp' of aws:ec2/instance:Instance 'inst'")
	// Each element of the list says which subnet it is.
	assert.Equal(t, []string{"urn:x::alb | subnets=s1,s2"}, got["subnets"])
	// A value derived from an output is unknown, not identifiable.
	assert.Contains(t, strings.Join(got["derived"], ""), "string value at .policy can't be known during preview")
	assert.Equal(t, apitype.Advisory, levels["derived"])

	// Outcomes are explicit. Passes produce no diagnostic; a violation on one resource fails the policy even when
	// another passed.
	assert.Empty(t, got["encrypted"])
	assert.Equal(t, []string{"urn:x::efs2 | new key"}, got["known-key"])
	// A typed policy runs once per matching resource ("*" matches all of them) and gets no notApplicable.
	require.Len(t, got["every"], len(linkedStack(true)))
	assert.Equal(t, []string{
		"urn:x::efs | keys=reportPass,reportViolation", "urn:x::efs2 | keys=reportPass,reportViolation",
	}, got["no-na"])
	// Not applicable is implicit: no matching resource, or nothing reported.
	nas := map[string]string{}
	for _, na := range resp.NotApplicable {
		nas[na.PolicyName] = na.Reason
	}
	assert.Equal(t, map[string]string{
		"not-here":     "no resources of type aws:rds/instance:Instance",
		"silent":       "policy reported no result",
		"silent-typed": "policy reported no result",
	}, nas)

	// Guards are off again once the v2 policies are done: plain JS string ops on the same text work.
	v, err := a.rt.RunString(`"output-0000000000000000.id".startsWith("output")`)
	require.NoError(t, err)
	assert.True(t, v.ToBoolean())
}

// Without output sources from the program's SDK, an unknown input can't be identified: it is "can't be known during
// preview", never a guess from propertyDependencies. Outputs are still identifiable.
func TestPureJSInputWithoutSources(t *testing.T) {
	t.Parallel()
	a := newTestJSAnalyzer(t, testInputPack)
	resp, err := a.AnalyzeStack(t.Context(), linkedStack(false))
	require.NoError(t, err)
	got, levels := byPolicy(resp)

	assert.Contains(t, strings.Join(got["pab-linked"], ""), "string value at .bucket can't be known during preview")
	assert.Equal(t, apitype.Advisory, levels["pab-linked"])
	assert.Equal(t, []string{
		"urn:x::efs | key=key arnEq=true idEq=false typeof=string kms=arn:aws:kms:us-west-2:123456789012:key/1111-2222",
	}, got["efs-key"][:1])
	assert.Contains(t, got["efs-key"][1], "string value at .kmsKeyId can't be known during preview")
	assert.Contains(t, strings.Join(got["subnets"], ""), "string value at .subnets.0 can't be known during preview")
	assert.Contains(t, strings.Join(got["derived"], ""), "string value at .policy can't be known during preview")
	assert.Equal(t, "urn:x::inst | metadataOptions=undefined outputHttpTokens=optional publicIpEqArn=false",
		got["reads-prop"][0])
}

// An identifiable unknown only supports identity and explicit conversion to text; everything else is reading into it.
func TestPureJSIdentifiableUnknown(t *testing.T) {
	t.Parallel()
	a := newTestJSAnalyzer(t, testInputPack)
	_, err := a.GetAnalyzerInfo(t.Context())
	require.NoError(t, err)

	v, err := a.rt.RunString(`
		var info = {urn: "urn:x::b", type: "aws:s3/bucket:Bucket", name: "b", property: "id"};
		var u = __unknown("output-0123456789abcdef.id", info);
		var same = __unknown("output-0123456789abcdef.id", {});
		__beginInput({});
		function probe(f) {
			try { var r = f(); return typeof r === "boolean" || typeof r === "string" ? String(r) : typeof r; }
			catch (e) { return e.name + ": " + e.message; }
		}
		var out = {
			identity: probe(() => u === same && [u].includes(same) && new Set([u]).has(same) && new Map([[u, 1]]).has(same)),
			typeof: probe(() => typeof u),
			truthy: probe(() => !!u),
			literal: probe(() => u === "output-0123456789abcdef.id"),
			template: probe(() => ` + "`${u}`" + `),
			string: probe(() => String(u)),
			key: probe(() => { var m = {}; m[u] = 1; return Object.keys(m)[0]; }),
			json: probe(() => JSON.stringify({ b: u })),
			concat: probe(() => "x" + u),
			looseEq: probe(() => u == "x"),
			compare: probe(() => u <= 22),
			prop: probe(() => u.length),
			method: probe(() => u.trim()),
			keys: probe(() => Object.keys(u)),
			spread: probe(() => [...u]),
			stringMethod: probe(() => "arn:x".startsWith(String(u))),
			templateThenMethod: probe(() => ` + "`${u}`" + `.split(":")),
			adapterRef: probe(() => u[Symbol.for("pulumi.unknown")]),
		};
		__endInput();
		JSON.stringify(out);`)
	require.NoError(t, err)
	out := map[string]string{}
	require.NoError(t, json.Unmarshal([]byte(v.String()), &out))
	const err0 = "OutputAccessError: "
	const on = " on the output 'id' of aws:s3/bucket:Bucket 'b'"
	assert.Equal(t, map[string]string{
		"identity":           "true",
		"typeof":             "object",
		"truthy":             "true",
		"literal":            "false",
		"template":           "output-0123456789abcdef.id",
		"string":             "output-0123456789abcdef.id",
		"key":                "output-0123456789abcdef.id",
		"json":               `{"b":"output-0123456789abcdef.id"}`,
		"concat":             err0 + "+ or == with a value" + on,
		"looseEq":            err0 + "+ or == with a value" + on,
		"compare":            err0 + "numeric use" + on,
		"prop":               err0 + ".length" + on,
		"method":             err0 + ".trim" + on,
		"keys":               err0 + "listing its keys" + on,
		"spread":             err0 + "iteration or inspection" + on,
		"stringMethod":       err0 + ".startsWith()" + on,
		"templateThenMethod": err0 + ".split()" + on,
		"adapterRef":         "output-0123456789abcdef.id",
	}, out)
}

func byPolicy(resp AnalyzeResponse) (map[string][]string, map[string]apitype.EnforcementLevel) {
	got := map[string][]string{}
	levels := map[string]apitype.EnforcementLevel{}
	for _, d := range resp.Diagnostics {
		msg := d.Message[strings.Index(d.Message, "\n")+1:]
		got[d.PolicyName] = append(got[d.PolicyName], string(d.URN)+" | "+msg)
		levels[d.PolicyName] = d.EnforcementLevel
	}
	for k := range got {
		sort.Strings(got[k])
	}
	return got, levels
}

// A policy that catches a guard error and carries on keeps only the results it reported before reading the output.
func TestPureJSInputSwallowedPass(t *testing.T) {
	t.Parallel()
	a := newTestJSAnalyzer(t, testInputPack)
	_, err := a.GetAnalyzerInfo(t.Context())
	require.NoError(t, err)

	v, err := a.rt.RunString(`
		__beginInput({"output-x.id": {urn: "urn:x::b", type: "aws:s3/bucket:Bucket", name: "b", property: "id"}});
		var r = __invoke(function (input, ctx) {
			ctx.reportPass("urn:x::a");
			try { JSON.parse("output-x.id"); } catch (e) {}
			ctx.reportPass("urn:x::b");
			ctx.reportViolation("after");
		}, {resources: []}, true);
		__endInput();
		var v1 = __invoke(function (input, ctx) { ctx.reportViolation(Object.keys(ctx).sort().join(",")); }, {}, false);
		JSON.stringify([r, v1]);`)
	require.NoError(t, err)
	assert.JSONEq(t, `[
		{"v": [], "p": ["urn:x::a"], "out": "JSON.parse() on the output 'id' of aws:s3/bucket:Bucket 'b'"},
		{"v": [["notApplicable,reportViolation", null]], "p": []}
	]`, v.String())
}

func TestPureJSInputRejectsKind(t *testing.T) {
	t.Parallel()
	a := newTestJSAnalyzer(t, `globalThis.__pulumiPolicyPack = {abiVersion: 2, name: "p", version: "1.0.0", policies: [
		{name: "x", kind: "resource", resourceTypes: ["aws:s3/bucket:Bucket"], validate: function () {}}]};`)
	_, err := a.GetAnalyzerInfo(t.Context())
	assert.ErrorContains(t, err, `policy "x": ABI v2 policies have no kind or scope`)
}

func urnsOf(lines []string) []string {
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		out = append(out, l[:strings.Index(l, " | ")])
	}
	return out
}

const testTemplatePack = `
function byName(rs, n) { return rs.find(function (r) { return r.name === n; }); }
function policy(name, validate) { return { name: name, description: name, validate: validate }; }
globalThis.__pulumiPolicyPack = {
  abiVersion: 2, name: "template-pack", version: "0.0.1", enforcementLevel: "mandatory",
  policies: [
    policy("doc", function (input, ctx) {
      var good = byName(input.resources, "good"), bp = byName(input.resources, "bp");
      var doc = JSON.parse(bp.inputs.policy), st = doc.Statement[0];
      ctx.reportViolation([typeof bp.inputs.policy, st.Effect, st.Condition.Bool["aws:SecureTransport"],
        st.Resource[0] === good.outputs.arn, st.Resource[1] === ` + "`${good.outputs.arn}/*`" + `,
        typeof st.Resource[0], JSON.parse(bp.inputs.policy).Statement[0].Resource[0] === st.Resource[0]].join(" "),
        bp.urn);
    }),
    policy("doc-read", function (input, ctx) {
      var bp = byName(input.resources, "bp");
      if (bp.inputs.policy.includes("Deny")) ctx.reportPass(bp.urn);
    }),
    policy("joined", function (input, ctx) {
      var good = byName(input.resources, "good"), site = byName(input.resources, "site");
      ctx.reportViolation([site.inputs.endpoint === ` + "`https://${good.outputs.id}.s3.amazonaws.com`" + `,
        site.inputs.bucket === good.outputs.id, site.inputs.endpoint].join(" "), site.urn);
    }),
    policy("joined-read", function (input, ctx) {
      var site = byName(input.resources, "site");
      if (site.inputs.endpoint.startsWith("https://")) ctx.reportPass(site.urn);
    }),
    policy("untraced", function (input, ctx) {
      var site = byName(input.resources, "site");
      if (site.inputs.note) ctx.reportPass(site.urn);
    }),
    policy("legacy", function (input, ctx) {
      var good = byName(input.resources, "good"), bp = byName(input.resources, "bp");
      var AS = Symbol.for("pulumi.unknownsAsStrings");
      globalThis[AS] = true;
      try {
        var r = JSON.parse(bp.inputs.policy).Statement[0].Resource;
        ctx.reportViolation([typeof r[0], r[0] === String(good.outputs.arn), r[1]].join(" "), bp.urn);
      } finally { globalThis[AS] = false; }
    }),
  ],
};
`

// Strings the program built from unknown outputs with interpolate, concat or jsonStringify keep their known parts:
// joined strings are their text with each unknown as its ref, and JSON documents parse into the document with each
// unknown as its identifiable unknown. Both can be compared, but not read into.
func TestPureJSInputTemplates(t *testing.T) {
	t.Parallel()
	a := newTestJSAnalyzer(t, testTemplatePack)
	_, err := a.GetAnalyzerInfo(t.Context())
	require.NoError(t, err)

	unk := property.New(property.Computed)
	str := property.New[string]
	arnSrc := OutputSource{URN: "urn:x::good", Property: "arn"}
	idSrc := OutputSource{URN: "urn:x::good", Property: "id"}
	doc := property.New(property.NewMap(map[string]property.Value{
		"Version": str("2012-10-17"),
		"Statement": property.New(property.NewArray([]property.Value{property.New(property.NewMap(map[string]property.Value{
			"Effect":    str("Deny"),
			"Principal": str("*"),
			"Action":    str("s3:*"),
			"Resource":  property.New(property.NewArray([]property.Value{unk, unk})),
			"Condition": property.New(property.NewMap(map[string]property.Value{
				"Bool": property.New(property.NewMap(map[string]property.Value{"aws:SecureTransport": str("false")})),
			})),
		}))})),
	}))
	joined := func(parts ...property.Value) property.Value { return property.New(property.NewArray(parts)) }

	rs := []AnalyzerStackResource{
		stackRes("urn:x::good", "aws:s3/bucket:Bucket", "", map[string]property.Value{"bucket": str("good-1")},
			map[string]property.Value{"id": unk, "arn": unk}, nil),
		stackRes("urn:x::bp", "aws:s3/bucketPolicy:BucketPolicy", "",
			map[string]property.Value{"bucket": unk, "policy": unk}, map[string]property.Value{"id": unk}, nil),
		stackRes("urn:x::site", "aws:s3/bucketWebsiteConfiguration:BucketWebsiteConfiguration", "",
			map[string]property.Value{"bucket": unk, "endpoint": unk, "note": unk},
			map[string]property.Value{"id": unk}, nil),
	}
	rs[1].UnknownInputs = map[string]OutputSource{
		"bucket": idSrc,
		"policy": {Template: &OutputTemplate{Kind: "json", Value: doc, Unknowns: map[string]OutputSource{
			"Statement.0.Resource.0": arnSrc,
			"Statement.0.Resource.1": {Template: &OutputTemplate{
				Kind: "concat", Value: joined(unk, str("/*")), Unknowns: map[string]OutputSource{"0": arnSrc},
			}},
		}}},
	}
	rs[2].UnknownInputs = map[string]OutputSource{
		// interpolate`${good.id}` is the output itself.
		"bucket": {Template: &OutputTemplate{
			Kind: "concat", Value: joined(str(""), unk, str("")), Unknowns: map[string]OutputSource{"1": idSrc},
		}},
		"endpoint": {Template: &OutputTemplate{
			Kind: "concat", Value: joined(str("https://"), unk, str(".s3.amazonaws.com")),
			Unknowns: map[string]OutputSource{"1": idSrc},
		}},
		// A part built with apply has no source, so the whole string can't be known.
		"note": {Template: &OutputTemplate{
			Kind: "concat", Value: joined(str("x-"), unk), Unknowns: map[string]OutputSource{
				"1": {Dependencies: []resource.URN{"urn:x::good"}},
			},
		}},
	}

	resp, err := a.AnalyzeStack(t.Context(), rs)
	require.NoError(t, err)
	got, levels := byPolicy(resp)

	idRef, arnRef := refFor("urn:x::good", "id"), refFor("urn:x::good", "arn")
	assert.Equal(t, []string{"urn:x::bp | string Deny false true true object true"}, got["doc"])
	assert.Equal(t, []string{"urn:x::site | true true https://<output good.id>.s3.amazonaws.com"}, got["joined"])
	assert.Equal(t, []string{"urn:x::bp | string true " + "<output good.arn>/*"}, got["legacy"])
	require.Len(t, got["doc-read"], 1)
	assert.Contains(t, got["doc-read"][0],
		".includes() on 'policy' of aws:s3/bucketPolicy:BucketPolicy 'bp', built from outputs")
	require.Len(t, got["joined-read"], 1)
	assert.Contains(t, got["joined-read"][0], ".startsWith() on 'endpoint' of "+
		"aws:s3/bucketWebsiteConfiguration:BucketWebsiteConfiguration 'site', built from outputs")
	require.Len(t, got["untraced"], 1)
	assert.Contains(t, got["untraced"][0], "string value at .note can't be known during preview")
	assert.Equal(t, apitype.Advisory, levels["untraced"])
	assert.NotEqual(t, idRef, arnRef)
}
