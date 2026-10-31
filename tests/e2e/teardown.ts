export default async function teardown() {
  await fetch('http://127.0.0.1:4100/__test_shutdown', { method: 'POST' }).catch(() => {});
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      await fetch('http://127.0.0.1:4100/api/health/live');
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch {
      return;
    }
  }
}
