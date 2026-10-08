// A stand-in for the gh CLI that answers the GraphQL queries github-worklog
// makes from canned data, the REST calls for the files of a commit from
// commitFiles, and the Pages REST calls from a small state object.
export function fakeGh({
  login = 'dev',
  pullRequests = {},
  commits = {},
  commitFiles = {},
  pageSize = Infinity,
  filePageSize = Infinity,
  pages = null,
} = {}) {
  const calls = [];
  const state = { pages };
  const gh = async (args, options = {}) => {
    calls.push({ args, input: options.input });
    if (args[0] === 'api' && args[1] === 'graphql') {
      const fields = Object.fromEntries(
        args
          .filter((_, i) => args[i - 1] === '-f' || args[i - 1] === '-F')
          .map((field) => [field.slice(0, field.indexOf('=')), field.slice(field.indexOf('=') + 1)]),
      );
      const repo = `${fields.owner}/${fields.name}`;
      if (fields.query.includes('user(login')) {
        return JSON.stringify({ data: { user: fields.login === login ? { id: 'U_1', login } : null } });
      }
      const start = fields.cursor ? Number(fields.cursor) : 0;
      const page = (list, size = pageSize, from = start) => ({
        pageInfo: { hasNextPage: from + size < list.length, endCursor: String(from + size) },
        nodes: list.slice(from, from + size),
      });
      const filesPage = (files, from) => page(files.map((path) => ({ path })), filePageSize, from);
      if (fields.query.includes('pullRequests(')) {
        if (!(repo in pullRequests)) return JSON.stringify({ data: { repository: null } });
        const withFiles = fields.query.includes('files(');
        const nodes = pullRequests[repo].map(({ changedFiles, headRefName, ...node }) =>
          withFiles ? { ...node, headRefName, files: filesPage(changedFiles, 0) } : node,
        );
        return JSON.stringify({ data: { repository: { pullRequests: page(nodes) } } });
      }
      if (fields.query.includes('pullRequest(')) {
        const found = pullRequests[repo].find((node) => node.number === Number(fields.number));
        return JSON.stringify({ data: { repository: { pullRequest: { files: filesPage(found.changedFiles, start) } } } });
      }
      if (fields.query.includes('history(')) {
        const list = commits[repo];
        const defaultBranchRef = list ? { target: { history: page(list) } } : null;
        return JSON.stringify({ data: { repository: { defaultBranchRef } } });
      }
    }
    const commitPath = args[0] === 'api' && args[1] === '--paginate' && args[2].match(/^repos\/([^/]+\/[^/]+)\/commits\/(\w+)$/);
    if (commitPath) {
      return commitFiles[commitPath[1]][commitPath[2]].map((file) => `${file}\n`).join('');
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

export const pr = (
  number,
  title,
  mergedAt,
  { author = 'dev', commitTimes = [], additions = 0, deletions = 0, files = [], branch = `work-${number}` } = {},
) => ({
  number,
  changedFiles: files,
  headRefName: branch,
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
