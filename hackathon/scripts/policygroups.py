#!/usr/bin/env python3
"""Manage the bench policy groups on the local service.

  policygroups.py show                       # list groups with their stacks and packs
  policygroups.py setup old|new              # group bench-<mode> = stack bench-<mode> + the 7 <mode> packs (latest)
  policygroups.py isolate                    # remove the bench/demo stacks from every other group
  policygroups.py attach <group> <project> <stack>
"""
import json, os, sys, urllib.request

API = os.environ.get("PULUMI_API", "http://localhost:8080")
ORG = os.environ.get("ORG", "pulumi_local")
PROJECT = "policy-bench"
PACKS = ["cis-aws", "cmmc-aws", "hitrust-aws", "iso-27001-aws", "nist-aws", "pci-dss-aws", "pulumi-best-practices-aws"]
PREFIX = {"old": "old-", "new": os.environ.get("NEW_PREFIX", "")}

def token():
    creds = json.load(open(os.path.expanduser("~/.pulumi/credentials.json")))
    return creds["accounts"][API]["accessToken"]

def call(method, path, body=None):
    req = urllib.request.Request(API + "/api" + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "token " + token(), "Content-Type": "application/json",
                 "Accept": "application/vnd.pulumi+8"})
    try:
        with urllib.request.urlopen(req) as r:
            data = r.read()
            return json.loads(data) if data else None
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path} -> {e.code}: {e.read().decode()[:500]}")

def groups():
    return call("GET", f"/orgs/{ORG}/policygroups")["policyGroups"]

def show():
    for g in groups():
        d = call("GET", f"/orgs/{ORG}/policygroups/{urllib.parse.quote(g['name'])}")
        stacks = [f"{s.get('routingProject')}/{s['name']}" for s in d.get("stacks", [])]
        packs = [f"{p['name']}@{p.get('versionTag')}" for p in d.get("appliedPolicyPacks", [])]
        print(f"{g['name']}: stacks={stacks} packs={packs}")

def latest(name):
    packs = call("GET", f"/orgs/{ORG}/policypacks")["policyPacks"]
    for p in packs:
        if p["name"] == name:
            return {"name": name, "version": p["versions"][0], "versionTag": p["versionTags"][0]}
    sys.exit(f"pack {name} not found in {ORG}")

def setup(mode):
    name = f"bench-{mode}"
    if name not in [g["name"] for g in groups()]:
        call("POST", f"/orgs/{ORG}/policygroups", {"name": name, "entityType": "stacks"})
    packs = [latest(PREFIX[mode] + p) for p in PACKS]
    cur = call("GET", f"/orgs/{ORG}/policygroups/{name}")
    for p in cur.get("appliedPolicyPacks", []):
        call("PATCH", f"/orgs/{ORG}/policygroups/{name}",
             {"removePolicyPack": {"name": p["name"], "version": p.get("version"), "versionTag": p.get("versionTag")}})
    if not any(s["name"] == name and s.get("routingProject") == PROJECT for s in cur.get("stacks", [])):
        call("PATCH", f"/orgs/{ORG}/policygroups/{name}", {"addStack": {"name": name, "routingProject": PROJECT}})
    for p in packs:
        call("PATCH", f"/orgs/{ORG}/policygroups/{name}", {"addPolicyPack": p})
    print(f"{name}: {[p['name'] + '@' + p['versionTag'] for p in packs]}")

def attach(group, project, stack):
    call("PATCH", f"/orgs/{ORG}/policygroups/{group}", {"addStack": {"name": stack, "routingProject": project}})
    print(f"attached {project}/{stack} to {group}")

def isolate():
    for g in groups():
        if g["name"].startswith("bench-"):
            continue
        d = call("GET", f"/orgs/{ORG}/policygroups/{urllib.parse.quote(g['name'])}")
        for s in d.get("stacks", []):
            if s.get("routingProject") in (PROJECT, "policy-demo", "policy-bench-linked"):
                call("PATCH", f"/orgs/{ORG}/policygroups/{urllib.parse.quote(g['name'])}",
                     {"removeStack": {"name": s["name"], "routingProject": s["routingProject"]}})
                print(f"removed {s['routingProject']}/{s['name']} from {g['name']}")

import urllib.parse
{"show": lambda: show(), "setup": lambda: setup(sys.argv[2]), "isolate": lambda: isolate(),
 "attach": lambda: attach(*sys.argv[2:5])}[sys.argv[1]]()
