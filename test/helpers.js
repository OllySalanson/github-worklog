// A stand-in for the gh CLI that answers the GraphQL queries github-worklog
// makes from canned data, and the Pages REST calls from a small state object.
export function fakeGh({ login = 'dev', pullRequests = {}, commits = {}, pageSize = Infinity, pages = null } = {}) {
  const calls = [];
  const state = { pages };
  const gh = async (args, options = {}) => {
    calls.push({ args, input: options.input });
    if (args[0] === 'api' && args[1] === 'graphql') {
      const fields = Object.fromEntries(
        args
          .filter((_, i) => args[i - 1] === '-f')
          .map((field) => [field.slice(0, field.indexOf('=')), field.slice(field.indexOf('=') + 1)]),
      );
      const repo = `${fields.owner}/${fields.name}`;
      if (fields.query.includes('user(login')) {
        return JSON.stringify({ data: { user: fields.login === login ? { id: 'U_1', login } : null } });
      }
      const start = fields.cursor ? Number(fields.cursor) : 0;
      const page = (list) => ({
        pageInfo: { hasNextPage: start + pageSize < list.length, endCursor: String(start + pageSize) },
        nodes: list.slice(start, start + pageSize),
      });
      if (fields.query.includes('pullRequests(')) {
        if (!(repo in pullRequests)) return JSON.stringify({ data: { repository: null } });
        return JSON.stringify({ data: { repository: { pullRequests: page(pullRequests[repo]) } } });
      }
      if (fields.query.includes('history(')) {
        const list = commits[repo];
        const defaultBranchRef = list ? { target: { history: page(list) } } : null;
        return JSON.stringify({ data: { repository: { defaultBranchRef } } });
      }
    }
    if (args[0] === 'api' && /^repos\/[^/]+\/[^/]+\/pages$/.test(args.at(-1)) && args.length === 2) {
      if (!state.pages) throw new Error('gh failed: Not Found (HTTP 404)');
      return JSON.stringify(state.pages);
    }
    if (args[0] === 'api' && args[1] === '-X') {
      const body = JSON.parse(options.input);
      state.pages = { html_url: 'https://dev.github.io/site/', source: body.source };
      return args[2] === 'POST' ? JSON.stringify(state.pages) : '';
    }
    throw new Error(`Unexpected gh call: ${args.join(' ')}`);
  };
  return { gh, calls, state };
}

export const pr = (number, title, mergedAt, { author = 'dev', commitTimes = [], additions = 0, deletions = 0 } = {}) => ({
  number,
  additions,
  deletions,
  title,
  url: `https://github.com/acme/app/pull/${number}`,
  mergedAt,
  author: { login: author },
  commits: { nodes: commitTimes.map((authoredDate) => ({ commit: { authoredDate } })) },
});

export const commit = (oid, message, authoredDate, { parents = 1, prStates = [], additions = 0, deletions = 0 } = {}) => ({
  oid,
  additions,
  deletions,
  url: `https://github.com/acme/app/commit/${oid}`,
  message,
  authoredDate,
  parents: { totalCount: parents },
  associatedPullRequests: { nodes: prStates.map((state) => ({ state })) },
});
