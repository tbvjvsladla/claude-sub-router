let tail = Promise.resolve();
let baseline;

export function register(on) {
  on('agent.spawn', async ($, event, next) => {
    const previous = tail;
    let release;
    tail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      if (!baseline) {
        const initial = JSON.parse((await $.env.get('CLAUDE_SUB_DYNAMIC_BASELINE')) ?? '{}');
        if (initial.initialOverride) {
          const settingsEnv = await $.settings.read({ key: 'env' });
          baseline = {
            model: typeof settingsEnv?.CLAUDE_CODE_SUBAGENT_MODEL === 'string' ? settingsEnv.CLAUDE_CODE_SUBAGENT_MODEL : initial.model,
            force: typeof settingsEnv?.CLAUDE_CODE_SUBAGENT_MODEL_FORCE === 'string' ? settingsEnv.CLAUDE_CODE_SUBAGENT_MODEL_FORCE : initial.force,
          };
        } else {
          baseline = {
            model: await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL'),
            force: await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL_FORCE'),
          };
        }
      }
      const node = await $.env.get('CLAUDE_SUB_DYNAMIC_NODE');
      const cli = await $.env.get('CLAUDE_SUB_DYNAMIC_CLI');
      if (!node || !cli) return { deny: 'claude-sub dynamic policy is unavailable' };
      const result = await $.process.run([node, cli, 'subagent-policy']);
      if (result.exitCode !== 0) return { deny: 'claude-sub model policy is invalid; check subagents.local.yaml' };
      const policy = JSON.parse(result.stdout);
      const model = policy.model === 'inherit' ? baseline.model : policy.model;
      const force = policy.model === 'inherit' ? baseline.force : policy.force ? '1' : '0';
      const setModel = await $.env.set('CLAUDE_CODE_SUBAGENT_MODEL', model);
      const setForce = await $.env.set('CLAUDE_CODE_SUBAGENT_MODEL_FORCE', force);
      if (setModel.deny || setForce.deny) return { deny: 'claude-sub could not apply the subagent model policy' };
      return await next(event);
    } finally {
      release();
    }
  }).catch(async ($, event, next) => next.called ? undefined : { deny: 'claude-sub could not read the subagent model policy' });
}
