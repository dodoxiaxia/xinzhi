// 心知:Cloudflare Cron Trigger → 触发 GitHub Actions 的轻量刷新(mode=fast)
// 作用:GitHub 自带的定时器在新仓库上可能迟到/漏跑,用 Cloudflare 的定时器做准点兜底。
// 需要 Worker 密钥 GH_TOKEN(细粒度令牌,仅限本仓库,权限 Actions: Read and write)。
const REPO = 'dodoxiaxia/xinzhi';
const WORKFLOW = 'daily.yml';

async function dispatch(env) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GH_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'xinzhi-cron',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: 'main', inputs: { mode: 'fast' } }),
  });
  const text = r.status === 204 ? '' : await r.text();
  console.log('dispatch', r.status, text.slice(0, 200));
  return r.status;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatch(env));
  },
  async fetch() {
    return new Response('xinzhi-cron: ok (scheduled only)', { status: 200 });
  },
};
