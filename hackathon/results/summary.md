# Policy runtime benchmark summary

Generated 2026-09-28T11:57:56.

Floor (preview, no policy packs): 1.519 s median.

| mode | path | phase | n | median (s) | min | max | violations | policy cache |
|---|---|---|---|---|---|---|---|---|
| new | cloud | cold | 3 | 1.47 | 1.434 | 3.102 | [276] | 2.5 MB / 14 files |
| new | cloud | warm | 3 | 1.46 | 1.438 | 1.78 | [276] | 2.5 MB / 14 files |
| new | local | run | 3 | 1.44 | 1.431 | 1.51 | [276] | – |
| old | cloud | cold | 3 | 99.51 | 94.967 | 113.805 | [276] | 2158.1 MB / 257898 files |
| old | cloud | warm | 3 | 11.62 | 10.307 | 11.851 | [276] | 2158.1 MB / 257898 files |
| old | local | run | 3 | 8.57 | 7.798 | 9.999 | [276] | – |

## Verbose breakdowns

```json
{
 "new-cloud": {
  "wall_s": 1.518,
  "log_span_s": 1.46,
  "install_s_by_pack": {
   "cis-aws@v1.0.2-purejs": 0.03,
   "pci-dss-aws@v2.0.4-purejs": 0.03,
   "hitrust-aws@v2.6.4-purejs": 0.03,
   "cmmc-aws@v1.0.2-purejs": 0.03,
   "nist-aws@v1.0.2-purejs": 0.03,
   "iso-27001-aws@v1.0.1-purejs": 0.03,
   "pulumi-best-practices-aws@v1.4.1-purejs": 0.03
  },
  "install_wall_s": 0.03,
  "first_install_begin_s": 0.52,
  "first_get_analyzer_info_s": null,
  "first_analyze_or_load_s": 0.56,
  "last_purejs_loaded_s": 0.59,
  "plugin_launches": [
   "yaml",
   "yaml",
   "aws (resource)"
  ],
  "policy_processes_spawned": 0,
  "purejs_timings": [
   "purejs pack pulumi-best-practices-aws: 54 policies, 160KB, read=68.708\u00b5s compile=7.0675ms eval=3.954708ms describe=1.254834ms total=12.34575ms",
   "purejs pack cmmc-aws: 54 policies, 174KB, read=313.042\u00b5s compile=5.625916ms eval=5.02125ms describe=1.294167ms total=12.254375ms",
   "purejs pack cis-aws: 115 policies, 334KB, read=65.167\u00b5s compile=14.239958ms eval=3.352458ms describe=4.08925ms total=21.746833ms",
   "purejs pack hitrust-aws: 130 policies, 326KB, read=248.542\u00b5s compile=13.262625ms eval=6.517792ms describe=2.695083ms total=22.724042ms",
   "purejs pack nist-aws: 139 policies, 401KB, read=254.333\u00b5s compile=16.528083ms eval=4.579459ms describe=3.636166ms total=24.998041ms",
   "purejs pack pci-dss-aws: 160 policies, 467KB, read=109.875\u00b5s compile=19.1475ms eval=3.7185ms describe=3.857167ms total=26.833042ms",
   "purejs pack iso-27001-aws: 238 policies, 609KB, read=141.459\u00b5s compile=21.783583ms eval=4.704833ms describe=7.499417ms total=34.129292ms",
   "purejs pack pci-dss-aws: analyze calls=12 total=41.2045ms",
   "purejs pack pulumi-best-practices-aws: analyze calls=12 total=1.822082ms",
   "purejs pack iso-27001-aws: analyze calls=12 total=43.608746ms",
   "purejs pack nist-aws: analyze calls=12 total=1.615374ms",
   "purejs pack hitrust-aws: analyze calls=12 total=42.830622ms",
   "purejs pack cmmc-aws: analyze calls=12 total=1.696624ms",
   "purejs pack cis-aws: analyze calls=12 total=1.116833ms"
  ]
 },
 "new-local": {
  "wall_s": 1.383,
  "log_span_s": 1.32,
  "install_s_by_pack": {},
  "install_wall_s": null,
  "first_install_begin_s": null,
  "first_get_analyzer_info_s": null,
  "first_analyze_or_load_s": 0.48,
  "last_purejs_loaded_s": 0.5,
  "plugin_launches": [
   "yaml",
   "yaml",
   "aws (resource)"
  ],
  "policy_processes_spawned": 0,
  "purejs_timings": [
   "purejs pack pulumi-best-practices-aws: 54 policies, 160KB, read=53.917\u00b5s compile=5.644542ms eval=2.220166ms describe=3.36575ms total=11.284375ms",
   "purejs pack cmmc-aws: 54 policies, 174KB, read=67.75\u00b5s compile=6.113125ms eval=5.191542ms describe=1.466417ms total=12.838834ms",
   "purejs pack hitrust-aws: 130 policies, 326KB, read=171.375\u00b5s compile=11.672084ms eval=3.66025ms describe=3.887708ms total=19.391417ms",
   "purejs pack cis-aws: 115 policies, 334KB, read=87.542\u00b5s compile=12.336541ms eval=4.2935ms describe=3.541625ms total=20.259208ms",
   "purejs pack nist-aws: 139 policies, 401KB, read=109.209\u00b5s compile=14.112333ms eval=4.911208ms describe=3.592209ms total=22.724959ms",
   "purejs pack pci-dss-aws: 160 policies, 467KB, read=200.167\u00b5s compile=18.343166ms eval=3.305042ms describe=5.42975ms total=27.278125ms",
   "purejs pack iso-27001-aws: 238 policies, 609KB, read=270.5\u00b5s compile=21.631709ms eval=6.469208ms describe=5.349625ms total=33.721042ms",
   "purejs pack /Users/alejandrocotroneo/go/src/github.com/pulumi/pulumi/hackathon/.build/new/cis-aws: analyze calls=12 total=1.212876ms",
   "purejs pack /Users/alejandrocotroneo/go/src/github.com/pulumi/pulumi/hackathon/.build/new/pci-dss-aws: analyze calls=12 total=41.440167ms",
   "purejs pack /Users/alejandrocotroneo/go/src/github.com/pulumi/pulumi/hackathon/.build/new/iso-27001-aws: analyze calls=12 total=42.483375ms",
   "purejs pack /Users/alejandrocotroneo/go/src/github.com/pulumi/pulumi/hackathon/.build/new/hitrust-aws: analyze calls=12 total=41.912667ms",
   "purejs pack /Users/alejandrocotroneo/go/src/github.com/pulumi/pulumi/hackathon/.build/new/pulumi-best-practices-aws: analyze calls=12 total=2.136376ms",
   "purejs pack /Users/alejandrocotroneo/go/src/github.com/pulumi/pulumi/hackathon/.build/new/cmmc-aws: analyze calls=12 total=1.87604ms",
   "purejs pack /Users/alejandrocotroneo/go/src/github.com/pulumi/pulumi/hackathon/.build/new/nist-aws: analyze calls=12 total=1.926378ms"
  ]
 },
 "old-local": {
  "wall_s": 7.933,
  "log_span_s": 7.83,
  "install_s_by_pack": {},
  "install_wall_s": null,
  "first_install_begin_s": null,
  "first_get_analyzer_info_s": 1.46,
  "first_analyze_or_load_s": 6.81,
  "last_purejs_loaded_s": null,
  "plugin_launches": [
   "yaml",
   "yaml",
   "/Users/alejandrocotroneo/go/src/github.com/pulumi/pulumi/hackathon/.build/old/old-pulumi-best-practices-aws (analyzer)",
   "nodejs",
   "/Users/alejandrocotroneo/go/src/github.com/pulumi/pulumi/hackathon/.build/old/old-pci-dss-aws (analyzer)",
   "/Users/alejandrocotroneo/go/src/github.com/pulumi/pulumi/hackathon/.build/old/old-cis-aws (analyzer)",
   "/Users/alejandrocotroneo/go/src/github.com/pulumi/pulumi/hackathon/.build/old/old-cmmc-aws (analyzer)",
   "/Users/alejandrocotroneo/go/src/github.com/pulumi/pulumi/hackathon/.build/old/old-hitrust-aws (analyzer)",
   "/Users/alejandrocotroneo/go/src/github.com/pulumi/pulumi/hackathon/.build/old/old-nist-aws (analyzer)",
   "/Users/alejandrocotroneo/go/src/github.com/pulumi/pulumi/hackathon/.build/old/old-iso-27001-aws (analyzer)",
   "aws (resource)"
  ],
  "policy_processes_spawned": 8,
  "purejs_timings": []
 },
 "old-cloud": {
  "wall_s": 99.174,
  "log_span_s": 98.86,
  "install_s_by_pack": {
   "old-nist-aws@v1.0.2": 87.44,
   "old-cmmc-aws@v1.0.2": 50.45,
   "old-pulumi-best-practices-aws@v1.4.1": 86.88,
   "old-iso-27001-aws@v1.0.1": 87.5,
   "old-cis-aws@v1.0.2": 50.46,
   "old-hitrust-aws@v2.6.4": 85.89,
   "old-pci-dss-aws@v2.0.4": 86.65
  },
  "install_wall_s": 87.5,
  "first_install_begin_s": 0.84,
  "first_get_analyzer_info_s": 89.49,
  "first_analyze_or_load_s": 96.49,
  "last_purejs_loaded_s": null,
  "plugin_launches": [
   "yaml",
   "yaml",
   "nodejs",
   "old-cis-aws (analyzer)",
   "old-pci-dss-aws (analyzer)",
   "old-cmmc-aws (analyzer)",
   "old-pulumi-best-practices-aws (analyzer)",
   "old-hitrust-aws (analyzer)",
   "old-nist-aws (analyzer)",
   "old-iso-27001-aws (analyzer)",
   "aws (resource)"
  ],
  "policy_processes_spawned": 8,
  "purejs_timings": []
 }
}
```

## Parity

```json
{
 "cloud": {
  "path": "cloud",
  "old": 276,
  "new": 276,
  "matching": 276,
  "only_old": 0,
  "only_new": 0,
  "only_old_by_policy": [],
  "only_new_by_policy": []
 },
 "local": {
  "path": "local",
  "old": 276,
  "new": 276,
  "matching": 276,
  "only_old": 0,
  "only_new": 0,
  "only_old_by_policy": [],
  "only_new_by_policy": []
 }
}
```

## CLI binary size (release flags, stripped)

| target | base | with goja | delta | base gzip | goja gzip | delta gzip |
|---|---|---|---|---|---|---|
| darwin/arm64 | 117.1 MB | 123.2 MB | +6.03 MB (+5.1%) | 33.9 MB | 35.9 MB | +1.97 MB (+5.8%) |
| linux/amd64 | 123.6 MB | 129.8 MB | +6.16 MB (+5.0%) | 36.0 MB | 38.1 MB | +2.10 MB (+5.8%) |
| windows/amd64 | 126.1 MB | 132.4 MB | +6.27 MB (+5.0%) | 36.7 MB | 38.8 MB | +2.12 MB (+5.8%) |

Where the bytes go (darwin/arm64, unstripped symbol sizes):

- 1.77 MB — Go runtime tables for the new code (pclntab)
- 1.74 MB — goja (engine)
- 1.46 MB — golang.org/x/text (newly linked packages)
- 1.11 MB — Go type/func metadata for the new code
- 0.25 MB — regexp2/v2 (goja's fallback regex engine)
- 0.03 MB — pulumi plugin pkg (purejs analyzer + prelude)
- 0.01 MB — go-sourcemap
- -0.05 MB — other
