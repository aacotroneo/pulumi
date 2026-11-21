// The entry point only wires the teams' modules together and exports their outputs.
import * as payments from "./src/payments";
import * as search from "./src/search";

export const receiptsBucket = payments.receipts.bucketName;
export const searchDbEndpoint = search.db.endpoint;
export const reindexQueue = search.reindex.url;
