# Shared settings for hackathon scripts.
HACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$HACK_DIR/.." && pwd)"
PPI_DIR="${PPI_DIR:-$REPO_DIR/../policy-packs-internal}"
PPI_PURE_DIR="${PPI_PURE_DIR:-$REPO_DIR/../policy-packs-internal-pure}"
RESULTS_DIR="$HACK_DIR/results"
ORG="${ORG:-pulumi_local}"
# pack-dir:pack-name
PACKS=(
  "packs/cis/aws:cis-aws"
  "packs/cmmc/aws:cmmc-aws"
  "packs/hitrust/aws:hitrust-aws"
  "packs/iso-27001/aws:iso-27001-aws"
  "packs/nist/aws:nist-aws"
  "packs/pci-dss/aws:pci-dss-aws"
  "packs/pulumi-best-practices/aws:pulumi-best-practices-aws"
)
