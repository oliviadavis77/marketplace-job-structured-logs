import { randomUUID } from "node:crypto";
import { infrai } from "./infrai_logs.ts";

type MarketplaceEntry = {
  timestamp: string;
  level: "info" | "error";
  service: string;
  message: string;
  context: {
    job_id: string;
    order_id: string;
    seller_id: string;
    action: string;
  };
};

async function shipOrder(orderId: string, sellerId: string): Promise<void> {
  const jobId = randomUUID();
  const entry: MarketplaceEntry = {
    timestamp: new Date().toISOString(),
    level: "info",
    service: "marketplace-job",
    message: "order shipped",
    context: { job_id: jobId, order_id: orderId, seller_id: sellerId, action: "ship" },
  };

  await infrai.logs.ingest({ entries: [entry], idempotency_key: `marketplace-job:${jobId}` });
  const matches = await infrai.logs.search({ q: `order_id:${orderId}`, service: "marketplace-job", limit: 10 });
  console.log(JSON.stringify({ orderId, matches }, null, 2));
}

const [orderId = "order-1042", sellerId = "seller-77"] = process.argv.slice(2);
shipOrder(orderId, sellerId).catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});

