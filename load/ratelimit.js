// k6 test: the sign-in limit must hold. One address hammering the login route has to be refused with 429,
// not be allowed to guess passwords forever.  k6 run -e BASE_URL=http://api:4000 load/ratelimit.js
import http from "k6/http";
import { check } from "k6";

const BASE = __ENV.BASE_URL || "http://127.0.0.1:4000";

export const options = { vus: 1, iterations: 60, thresholds: { checks: ["rate>0.99"] } };

export default function () {
  const r = http.post(`${BASE}/api/v1/auth/login`, JSON.stringify({ email: `victim${__ITER}@e2e.test`, password: "wrong password here" }),
    { headers: { "content-type": "application/json", "x-forwarded-for": "10.200.200.200" }, responseCallback: http.expectedStatuses(401, 429) });
  // Wrong passwords are 401 at first; before 60 attempts from one address the API must start answering 429.
  check(r, { "401 or 429 only": (x) => x.status === 401 || x.status === 429 });
  if (__ITER === 59) check(r, { "limit reached by attempt 60": (x) => x.status === 429 });
}
