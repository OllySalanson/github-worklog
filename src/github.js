import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// Runs a command and resolves with its stdout.
export function runCommand(command, args, { input, cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd, env, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
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

// GitHub answers some requests with a generic error, or a gateway error, that
// goes away when asked again: "Something went wrong while executing your
// query" comes and goes for minutes at a time on busy days.
const TRANSIENT =
  /Something went wrong while executing your query|couldn't respond to your request in time|HTTP 50[234]|timeout|ECONNRESET|ETIMEDOUT|unexpected EOF/i;

export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

// Wraps gh so a request that fails in a way that comes and goes is asked
// again, waiting longer each time, before giving up.
export function retryingGh(gh, { delays = RETRY_DELAYS_MS, sleep = delay } = {}) {
  return async (args, options) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await gh(args, options);
      } catch (error) {
        if (!TRANSIENT.test(error.message)) throw error;
        if (attempt === delays.length) {
          error.message += ` (GitHub failed ${attempt + 1} times in a row; try again later)`;
          throw error;
        }
        await sleep(delays[attempt]);
      }
    }
  };
}

// The commits of a pull request: when each was written, and enough to tell
// which commits on the default branch the pull request brought in.
const COMMIT_FIELDS = 'pageInfo { hasNextPage endCursor } nodes { commit { oid authoredDate messageHeadline } }';

// With files, each pull request also names its branch and lists the files it
// changed, for repos that split their changes into projects.
const pullRequestsQuery = (files) => `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: MERGED, first: 50, after: $cursor, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url mergedAt additions deletions
        author { login }
        mergeCommit { oid }
        commits(first: 100) { ${COMMIT_FIELDS} }${files ? `
        headRefName
        files(first: 100) { pageInfo { hasNextPage endCursor } nodes { path } }` : ''}
      }
    }
  }
}`;

const PULL_REQUEST_FILES_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      files(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { path } }
    }
  }
}`;

const PULL_REQUEST_COMMITS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(first: 100, after: $cursor) { ${COMMIT_FIELDS} }
    }
  }
}`;

// Commits on the default branch carry no sign of the pull request they came
// from: asking GitHub for associatedPullRequests here fails often enough to
// break every run, so pull requests are matched to commits locally instead.
const HISTORY_QUERY = `query($owner: String!, $name: String!, $authorId: ID!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef {
      target {
        ... on Commit {
          history(first: 100, after: $cursor, author: {id: $authorId}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              oid url message messageHeadline authoredDate additions deletions
              parents { totalCount }
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
    // -F sends numbers as numbers; -f sends everything else as a string.
    if (value !== null && value !== undefined) args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`);
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

async function paginate(fetchPage, first = null) {
  const nodes = [];
  let cursor = null;
  if (first) {
    nodes.push(...first.nodes);
    if (!first.pageInfo.hasNextPage) return nodes;
    cursor = first.pageInfo.endCursor;
  }
  for (;;) {
    const connection = await fetchPage(cursor);
    if (!connection) return nodes;
    nodes.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) return nodes;
    cursor = connection.pageInfo.endCursor;
  }
}

// All the files a pull request changed, continuing from the first page that
// came with the pull request itself.
async function pullRequestFiles(gh, variables, pr) {
  const files = await paginate(async (cursor) => {
    const data = await graphql(gh, PULL_REQUEST_FILES_QUERY, { ...variables, number: pr.number, cursor });
    return data.repository.pullRequest.files;
  }, pr.files);
  return files.map((file) => file.path);
}

// All the commits of a pull request, continuing from the first page that came
// with the pull request itself.
async function pullRequestCommits(gh, variables, pr) {
  const commits = await paginate(async (cursor) => {
    const data = await graphql(gh, PULL_REQUEST_COMMITS_QUERY, { ...variables, number: pr.number, cursor });
    return data.repository.pullRequest.commits;
  }, pr.commits);
  return commits.map((node) => node.commit);
}

// A merged pull request brought a commit onto the default branch when the
// commit is its merge (or squash) commit, one of its own commits (a merge),
// or a copy of one written at the same moment with the same headline (a
// rebase, which gives each commit a new id).
function mergedCommitMatcher(pullRequests) {
  const oids = new Set();
  const copies = new Set();
  for (const pr of pullRequests) {
    if (pr.mergeCommit) oids.add(pr.mergeCommit.oid);
    for (const commit of pr.allCommits) {
      oids.add(commit.oid);
      copies.add(`${commit.authoredDate} ${commit.messageHeadline}`);
    }
  }
  return (commit) => oids.has(commit.oid) || copies.has(`${commit.authoredDate} ${commit.messageHeadline}`);
}

// The files a commit changed. GraphQL does not list them, so this is one REST
// call per commit (more for a very large one).
async function commitFiles(gh, repo, oid) {
  const output = await gh(['api', '--paginate', `repos/${repo.fullName}/commits/${oid}`, '--jq', '.files[].filename']);
  return output.split('\n').filter(Boolean);
}

// Runs task over each value, a few at a time, keeping their order.
async function mapLimit(values, limit, task) {
  const results = new Array(values.length);
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await task(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

// Merged pull requests by the author, plus commits the author pushed straight
// to the default branch that no merged pull request already covers. For a
// repo split into projects, each change also lists the files it changed, and
// each pull request names the branch it was made from.
export async function fetchRepoActivity(gh, repo, user) {
  const variables = { owner: repo.owner, name: repo.name };
  const login = user.login.toLowerCase();
  const withFiles = repo.projects?.length > 0;

  const pullRequests = await paginate(async (cursor) => {
    const data = await graphql(gh, pullRequestsQuery(withFiles), { ...variables, cursor });
    if (!data.repository) throw new Error(`Repository not found or not accessible: ${repo.fullName}`);
    return data.repository.pullRequests;
  });

  const history = await paginate(async (cursor) => {
    const data = await graphql(gh, HISTORY_QUERY, { ...variables, authorId: user.id, cursor });
    return data.repository?.defaultBranchRef?.target?.history ?? null;
  });

  for (const pr of pullRequests) pr.allCommits = await pullRequestCommits(gh, variables, pr);
  const inMergedPr = mergedCommitMatcher(pullRequests);

  const items = [];
  for (const pr of pullRequests) {
    if (pr.author?.login?.toLowerCase() !== login || !pr.mergedAt) continue;
    items.push({
      ...(withFiles && { files: await pullRequestFiles(gh, variables, pr), branch: pr.headRefName }),
      kind: 'pr',
      repo: repo.fullName,
      id: `#${pr.number}`,
      title: pr.title,
      url: pr.url,
      time: pr.mergedAt,
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      workTimes: pr.allCommits.map((commit) => commit.authoredDate),
    });
  }
  const commits = history.filter((commit) => !inMergedPr(commit) && commit.parents.totalCount <= 1);
  const files = withFiles ? await mapLimit(commits, 8, (commit) => commitFiles(gh, repo, commit.oid)) : [];
  for (const [index, commit] of commits.entries()) {
    items.push({
      ...(withFiles && { files: files[index] }),
      kind: 'commit',
      repo: repo.fullName,
      id: commit.oid.slice(0, 7),
      title: commit.message.split('\n')[0].trim(),
      url: commit.url,
      time: commit.authoredDate,
      additions: commit.additions ?? 0,
      deletions: commit.deletions ?? 0,
      workTimes: [],
    });
  }
  return items;
}

export async function fetchActivity(gh, config, retry = {}) {
  gh = retryingGh(gh, retry);
  const user = await fetchUser(gh, config.author);
  const items = [];
  for (const repo of config.repos) {
    items.push(...(await fetchRepoActivity(gh, repo, user)));
  }
  return items;
}
