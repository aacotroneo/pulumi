import * as aws from "@pulumi/aws";
import * as platform from "@acme/platform";

// Shared code outside src/<team>/ and platform/ that declares a resource nobody owns.
export const pager = new aws.sns.Topic("ops-pager", {}, { provider: platform.provider("platform") }); // violates: allowed-locations
