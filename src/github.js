import { execFile } from 'node:child_process';

// Runs a command and resolves with its stdout.
export function runCommand(command, args, { input, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = (stderr || error.message).trim();
        const failure = new Error(`${command} failed: ${detail}`);
        failure.stderr = stderr;
        reject(failure);
      } else {
        resolve(stdout);
      }
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

// The GitHub CLI, using its existing login.
export const runGh = (args, options) => runCommand('gh', args, options);

const USER_QUERY = `query($login: String!) { user(login: $login) { id login } }`;

const PULL_REQUESTS_QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: MERGED, first: 50, after: $cursor, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url mergedAt
        author { login }
        commits(first: 100) { nodes { commit { authoredDate } } }
      }
    }
  }
}`;

const HISTORY_QUERY = `query($owner: String!, $name: String!, $authorId: ID!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef {
      target {
        ... on Commit {
          history(first: 100, after: $cursor, author: {id: $authorId}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              oid url message authoredDate
              parents { totalCount }
              associatedPullRequests(first: 10) { nodes { state } }
            }
          }
        }
      }
    }
  }
}`;

export async function graphql(gh, query, variables) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value !== null && value !== undefined) args.push('-f', `${key}=${value}`);
  }
  const response = JSON.parse(await gh(args));
  if (response.errors?.length) {
    throw new Error(`GitHub API error: ${response.errors.map((e) => e.message).join('; ')}`);
  }
  return response.data;
}

export async function fetchUser(gh, login) {
  const data = await graphql(gh, USER_QUERY, { login });
  if (!data.user) throw new Error(`GitHub user not found: ${login}`);
  return data.user;
}

async function paginate(fetchPage) {
  const nodes = [];
  let cursor = null;
  for (;;) {
    const connection = await fetchPage(cursor);
    if (!connection) return nodes;
    nodes.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) return nodes;
    cursor = connection.pageInfo.endCursor;
  }
}

// Merged pull requests by the author, plus commits the author pushed straight
// to the default branch that no merged pull request already covers.
export async function fetchRepoActivity(gh, repo, user) {
  const variables = { owner: repo.owner, name: repo.name };
  const login = user.login.toLowerCase();

  const pullRequests = await paginate(async (cursor) => {
    const data = await graphql(gh, PULL_REQUESTS_QUERY, { ...variables, cursor });
    if (!data.repository) throw new Error(`Repository not found or not accessible: ${repo.fullName}`);
    return data.repository.pullRequests;
  });

  const history = await paginate(async (cursor) => {
    const data = await graphql(gh, HISTORY_QUERY, { ...variables, authorId: user.id, cursor });
    return data.repository?.defaultBranchRef?.target?.history ?? null;
  });

  const items = [];
  for (const pr of pullRequests) {
    if (pr.author?.login?.toLowerCase() !== login || !pr.mergedAt) continue;
    items.push({
      kind: 'pr',
      repo: repo.fullName,
      id: `#${pr.number}`,
      title: pr.title,
      url: pr.url,
      time: pr.mergedAt,
      workTimes: pr.commits.nodes.map((node) => node.commit.authoredDate),
    });
  }
  for (const commit of history) {
    const inMergedPr = commit.associatedPullRequests.nodes.some((pr) => pr.state === 'MERGED');
    const isMerge = commit.parents.totalCount > 1;
    if (inMergedPr || isMerge) continue;
    items.push({
      kind: 'commit',
      repo: repo.fullName,
      id: commit.oid.slice(0, 7),
      title: commit.message.split('\n')[0].trim(),
      url: commit.url,
      time: commit.authoredDate,
      workTimes: [],
    });
  }
  return items;
}

export async function fetchActivity(gh, config) {
  const user = await fetchUser(gh, config.author);
  const items = [];
  for (const repo of config.repos) {
    items.push(...(await fetchRepoActivity(gh, repo, user)));
  }
  return items;
}
