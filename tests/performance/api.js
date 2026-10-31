import http from 'k6/http';
import { check, sleep } from 'k6';
export const options = {
  vus: 100,
  duration: '60s',
  thresholds: { http_req_duration: ['p(95)<2000'], http_req_failed: ['rate<0.01'] },
};
export default function () {
  const response = http.get(
    `${__ENV.BASE_URL ?? 'http://localhost:4000'}/api/analytics/dashboard`,
    { headers: { Authorization: `Bearer ${__ENV.ACCESS_TOKEN}` } },
  );
  check(response, { 'successful authorized dashboard': (r) => r.status === 200 });
  sleep(1);
}
