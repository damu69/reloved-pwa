// k6 load test: normal shopper traffic against the API. Run by Jenkins; thresholds fail the build when the API is slow or erroring.
//   k6 run -e BASE_URL=http://api:4000 load/smoke.js
import http from "k6/http";
import { check, sleep } from "k6";

const BASE = __ENV.BASE_URL || "http://127.0.0.1:4000";
const API = `${BASE}/api/v1`;

export const options = {
  scenarios: {
    shoppers: { executor: "ramping-vus", startVUs: 0, stages: [
      { duration: "20s", target: 20 }, { duration: "40s", target: 20 }, { duration: "10s", target: 0 } ] },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],                 // under 1% errors
    http_req_duration: ["p(95)<800"],               // 95% of requests under 800 ms
    "http_req_duration{name:search}": ["p(95)<1000"],
  },
};

export default function () {
  // Each virtual user pretends to be a different visitor, so per-IP limits are not what is measured here.
  const params = { headers: { "x-forwarded-for": `10.${__VU % 250}.${(__ITER % 250)}.7` } };
  const home = http.get(`${API}/catalogue/gst-rates`, params);
  check(home, { "gst rates ok": (r) => r.status === 200 });
  const s = http.get(`${API}/catalogue/products?q=jacket&limit=20`, { ...params, tags: { name: "search" } });
  check(s, { "search ok": (r) => r.status === 200 });
  const h = http.get(`${BASE}/health`, params);
  check(h, { "health ok": (r) => r.status === 200 });
  sleep(1);
}
