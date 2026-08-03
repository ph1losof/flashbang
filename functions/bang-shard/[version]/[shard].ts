import {
  type CloudflareBangShardContext,
  handleCloudflareBangShard,
} from "../../../src/server/cloudflare-bang-shard";

export const onRequestGet = (context: CloudflareBangShardContext) =>
  handleCloudflareBangShard(context);
