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

// pulumi-language-purejs runs purejs policy packs (one dependency-free JS bundle each) with goja, so that a stock
// pulumi CLI can enforce them without Node.js or npm. The CLI uses it as the language plugin for `runtime: purejs`:
//
//   - InstallDependencies is a no-op, so Cloud-enforced packs install with a download and an extract;
//   - RunPlugin serves the pack as an Analyzer from this process and reports its port, the way a plugin binary would.
//
// Hackathon prototype.
package main

import (
	"context"
	"fmt"
	"os"
	"sync"

	"github.com/blang/semver"
	"google.golang.org/grpc"
	pbempty "google.golang.org/protobuf/types/known/emptypb"

	"github.com/pulumi/pulumi/pkg/v3/resource/plugin"
	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/pulumi/pulumi/sdk/v3/go/common/util/cmdutil"
	"github.com/pulumi/pulumi/sdk/v3/go/common/util/logging"
	"github.com/pulumi/pulumi/sdk/v3/go/common/util/rpcutil"
	pulumirpc "github.com/pulumi/pulumi/sdk/v3/proto/go"
)

const version = "0.1.0"

func main() {
	logging.InitLogging(false, 0, false)
	handle, err := rpcutil.ServeWithOptions(rpcutil.ServeOptions{
		Init: func(srv *grpc.Server) error {
			pulumirpc.RegisterLanguageRuntimeServer(srv, &host{})
			return nil
		},
		Options: rpcutil.OpenTracingServerInterceptorOptions(nil),
	})
	if err != nil {
		cmdutil.Exit(err)
	}
	fmt.Printf("%d\n", handle.Port)
	if err := <-handle.Done; err != nil {
		cmdutil.Exit(err)
	}
}

type host struct {
	pulumirpc.UnimplementedLanguageRuntimeServer
}

func (h *host) Handshake(
	context.Context, *pulumirpc.LanguageHandshakeRequest,
) (*pulumirpc.LanguageHandshakeResponse, error) {
	return &pulumirpc.LanguageHandshakeResponse{}, nil
}

func (h *host) GetPluginInfo(context.Context, *pbempty.Empty) (*pulumirpc.PluginInfo, error) {
	return &pulumirpc.PluginInfo{Version: version}, nil
}

func (h *host) GetRequiredPlugins(
	context.Context, *pulumirpc.GetRequiredPluginsRequest,
) (*pulumirpc.GetRequiredPluginsResponse, error) {
	return &pulumirpc.GetRequiredPluginsResponse{}, nil
}

func (h *host) GetRequiredPackages(
	context.Context, *pulumirpc.GetRequiredPackagesRequest,
) (*pulumirpc.GetRequiredPackagesResponse, error) {
	return &pulumirpc.GetRequiredPackagesResponse{}, nil
}

// InstallDependencies has nothing to do: a purejs pack is its bundle.
func (h *host) InstallDependencies(
	*pulumirpc.InstallDependenciesRequest, pulumirpc.LanguageRuntime_InstallDependenciesServer,
) error {
	return nil
}

// RunPlugin starts an Analyzer server for the pack in this process and streams its port as the plugin's stdout. The
// engine ends the plugin by cancelling the stream.
func (h *host) RunPlugin(req *pulumirpc.RunPluginRequest, stream pulumirpc.LanguageRuntime_RunPluginServer) error {
	if req.GetKind() != string(apitype.AnalyzerPlugin) {
		return fmt.Errorf("purejs only runs policy packs, not %q plugins", req.GetKind())
	}
	dir := req.GetInfo().GetProgramDirectory()
	if dir == "" {
		dir = req.GetPwd()
	}
	analyzer, err := plugin.NewPureJSAnalyzer(dir)
	if err != nil {
		return err
	}
	defer analyzer.Close()

	cancel := make(chan bool)
	stop := sync.OnceFunc(func() { close(cancel) })
	defer stop()
	handle, err := rpcutil.ServeWithOptions(rpcutil.ServeOptions{
		Cancel: cancel,
		Init: func(srv *grpc.Server) error {
			pulumirpc.RegisterAnalyzerServer(srv, plugin.NewAnalyzerServer(grpcView{analyzer}))
			return nil
		},
		Options: rpcutil.OpenTracingServerInterceptorOptions(nil),
	})
	if err != nil {
		return err
	}
	port := fmt.Sprintf("%d\n", handle.Port)
	if err := stream.Send(&pulumirpc.RunPluginResponse{
		Output: &pulumirpc.RunPluginResponse_Stdout{Stdout: []byte(port)},
	}); err != nil {
		return err
	}

	select {
	case <-stream.Context().Done():
		stop()
		return nil
	case err := <-handle.Done:
		if err != nil {
			fmt.Fprintf(os.Stderr, "purejs analyzer for %s: %v\n", dir, err)
		}
	}
	return stream.Send(&pulumirpc.RunPluginResponse{Output: &pulumirpc.RunPluginResponse_Exitcode{Exitcode: 0}})
}

// grpcView adapts what a gRPC analyzer receives to what the purejs analyzer reads. Over gRPC, stack resources carry
// only their properties (no separate inputs), which is also all the Node.js policy SDK gets, so ABI v1 packs see the
// same data either way; ABI v2 packs use the properties as their inputs.
type grpcView struct {
	plugin.Analyzer
}

func (g grpcView) AnalyzeStack(
	ctx context.Context, resources []plugin.AnalyzerStackResource,
) (plugin.AnalyzeResponse, error) {
	for i := range resources {
		r := &resources[i]
		if r.Inputs.Len() == 0 {
			r.Inputs = r.Properties
		}
		if id, ok := r.Properties.GetOk("id"); ok && r.ID == "" && id.IsString() {
			r.ID = resource.ID(id.AsString())
		}
	}
	return g.Analyzer.AnalyzeStack(ctx, resources)
}

func (g grpcView) GetPluginInfo(context.Context) (plugin.PluginInfo, error) {
	v := semver.MustParse(version)
	return plugin.PluginInfo{Version: &v}, nil
}
