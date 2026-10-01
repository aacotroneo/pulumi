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
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/structpb"

	"github.com/pulumi/pulumi/pkg/v3/resource/plugin"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
)

func TestCollectOutputSources(t *testing.T) {
	t.Parallel()

	output := func(fields map[string]any) map[string]any {
		fields[resource.SigKey] = resource.OutputValueSig
		return fields
	}
	obj, err := structpb.NewStruct(map[string]any{
		"name":     "plain",
		"kmsKeyId": output(map[string]any{"source": map[string]any{"urn": "urn:x::key", "property": "arn"}}),
		"subnets": []any{
			output(map[string]any{"source": map[string]any{"urn": "urn:x::s1", "property": "id"}}),
			"subnet-known",
			output(map[string]any{"source": map[string]any{"urn": "urn:x::s2", "property": "id"}}),
		},
		"tags": map[string]any{
			"Owner": output(map[string]any{"dependencies": []any{"urn:x::a", "urn:x::b"}}),
		},
		"secret": map[string]any{
			resource.SigKey: resource.SecretSig,
			"value":         output(map[string]any{"source": map[string]any{"urn": "urn:x::pw", "property": "result"}}),
		},
		// Known output values and output values without a source or dependencies say nothing.
		"known":   output(map[string]any{"value": "v", "source": map[string]any{"urn": "urn:x::k", "property": "id"}}),
		"unknown": output(map[string]any{}),
	})
	require.NoError(t, err)

	assert.Equal(t, map[string]plugin.OutputSource{
		"kmsKeyId":   {URN: "urn:x::key", Property: "arn"},
		"subnets.0":  {URN: "urn:x::s1", Property: "id"},
		"subnets.2":  {URN: "urn:x::s2", Property: "id"},
		"tags.Owner": {Dependencies: []resource.URN{"urn:x::a", "urn:x::b"}},
		"secret":     {URN: "urn:x::pw", Property: "result"},
	}, collectOutputSources(obj))

	plain, err := structpb.NewStruct(map[string]any{"name": "plain"})
	require.NoError(t, err)
	assert.Nil(t, collectOutputSources(plain))
}

func TestCollectOutputTemplates(t *testing.T) {
	t.Parallel()

	output := func(fields map[string]any) map[string]any {
		fields[resource.SigKey] = resource.OutputValueSig
		return fields
	}
	arn := output(map[string]any{"source": map[string]any{"urn": "urn:x::b", "property": "arn"}})
	obj, err := structpb.NewStruct(map[string]any{
		"endpoint": output(map[string]any{
			"dependencies": []any{"urn:x::b"},
			"template":     map[string]any{"concat": []any{"https://", arn, "/x"}},
		}),
		"policy": output(map[string]any{
			"template": map[string]any{"json": map[string]any{
				"Effect":   "Deny",
				"Resource": []any{arn, output(map[string]any{"template": map[string]any{"concat": []any{arn, "/*"}}})},
			}},
		}),
		"other": output(map[string]any{"template": map[string]any{"unsupported": 1}}),
	})
	require.NoError(t, err)

	got := collectOutputSources(obj)
	require.Contains(t, got, "endpoint")
	endpoint := got["endpoint"].Template
	require.NotNil(t, endpoint)
	assert.Equal(t, "concat", endpoint.Kind)
	parts := endpoint.Value.AsArray()
	assert.Equal(t, "https://", parts.Get(0).AsString())
	assert.True(t, parts.Get(1).IsComputed())
	assert.Equal(t, map[string]plugin.OutputSource{"1": {URN: "urn:x::b", Property: "arn"}}, endpoint.Unknowns)

	policy := got["policy"].Template
	require.NotNil(t, policy)
	assert.Equal(t, "json", policy.Kind)
	assert.Equal(t, "Deny", policy.Value.AsMap().Get("Effect").AsString())
	assert.Equal(t, plugin.OutputSource{URN: "urn:x::b", Property: "arn"}, policy.Unknowns["Resource.0"])
	nested := policy.Unknowns["Resource.1"].Template
	require.NotNil(t, nested)
	assert.Equal(t, map[string]plugin.OutputSource{"0": {URN: "urn:x::b", Property: "arn"}}, nested.Unknowns)

	assert.NotContains(t, got, "other")
}
