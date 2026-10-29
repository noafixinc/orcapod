import { execFile } from 'node:child_process'
import type { ChildProcess, ExecFileException } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchItem, fetchOpenItems, fetchRepoIsPrivate, listGhAccounts, parseIssues } from '../src/github.ts'
import type { Project } from '../src/types.ts'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

interface Reply { error?: ExecFileException; stdout?: string; stderr?: string }
interface Call { file: string; args: string[]; env: NodeJS.ProcessEnv | undefined; maxBuffer: number | undefined; timeout: number | undefined }
type Callback = (error: ExecFileException | null, stdout: string, stderr: string) => void

let calls: Call[]

function replyWith(reply: (args: string[]) => Reply): void {
  const fake = (file: string, args: string[], options: { env?: NodeJS.ProcessEnv; maxBuffer?: number; timeout?: number }, callback: Callback): ChildProcess => {
    calls.push({ file, args, env: options.env, maxBuffer: options.maxBuffer, timeout: options.timeout })
    const { error, stdout = '', stderr = '' } = reply(args)
    callback(error ?? null, stdout, stderr)
    return {} as ChildProcess
  }
  vi.mocked(execFile).mockImplementation(fake as unknown as typeof execFile)
}

function exitError(code: number): ExecFileException {
  return Object.assign(new Error('Command failed'), { code })
}

function timeoutError(): ExecFileException {
  return Object.assign(new Error('Command failed: gh'), { code: null, killed: true, signal: 'SIGTERM' as const }) as unknown as ExecFileException
}

function ghStub(api: Reply, token: Reply = { stdout: 'gho_test\n' }): (args: string[]) => Reply {
  return (args) => (args[0] === 'auth' ? token : api)
}

const project: Project = {
  name: 'todos',
  path: '/Users/me/git/todos',
  repo: 'acme-corp/todos',
  githubAccount: 'taylor',
  enabled: true,
  authors: ['OWNER', 'MEMBER', 'COLLABORATOR'],
  bots: ['dependabot[bot]'],
  rules: [],
}

const issue123 = {
  number: 123,
  title: 'Feature',
  html_url: 'https://github.com/acme-corp/todos/issues/123',
  labels: [{ name: ' Impl ' }],
  user: { login: 'taylor', type: 'User' },
  author_association: 'OWNER',
}

const pr130 = {
  number: 130,
  title: 'Bump yaml',
  html_url: 'https://github.com/acme-corp/todos/pull/130',
  labels: [{ name: 'dependencies' }],
  user: { login: 'dependabot[bot]', type: 'Bot' },
  author_association: 'NONE',
  pull_request: { url: 'https://api.github.com/repos/acme-corp/todos/pulls/130' },
}

beforeEach(() => {
  calls = []
  vi.mocked(execFile).mockReset()
})

describe('parseIssues', () => {
  it('flattens the --slurp page array and separates issues from PRs by the presence of pull_request', () => {
    const json = [
      [issue123, pr130],
      [{ number: 7, title: 'No labels', html_url: 'https://github.com/acme-corp/todos/issues/7', labels: [], user: { login: 'someone', type: 'User' }, author_association: 'MEMBER' }],
    ]
    expect(parseIssues(json, 'todos', 'acme-corp/todos')).toEqual([
      {
        project: 'todos',
        repo: 'acme-corp/todos',
        target: 'issue',
        number: 123,
        title: 'Feature',
        url: 'https://github.com/acme-corp/todos/issues/123',
        labels: ['impl'],
        author: { login: 'taylor', bot: false, association: 'OWNER' },
      },
      {
        project: 'todos',
        repo: 'acme-corp/todos',
        target: 'pr',
        number: 130,
        title: 'Bump yaml',
        url: 'https://github.com/acme-corp/todos/pull/130',
        labels: ['dependencies'],
        author: { login: 'dependabot[bot]', bot: true, association: 'NONE' },
      },
      {
        project: 'todos',
        repo: 'acme-corp/todos',
        target: 'issue',
        number: 7,
        title: 'No labels',
        url: 'https://github.com/acme-corp/todos/issues/7',
        labels: [],
        author: { login: 'someone', bot: false, association: 'MEMBER' },
      },
    ])
  })

  it('an empty page array gives 0 items', () => {
    expect(parseIssues([[]], 'todos', 'acme-corp/todos')).toEqual([])
    expect(parseIssues([], 'todos', 'acme-corp/todos')).toEqual([])
  })

  it('labels are trimmed and lowercased, string labels are also read as names, and entries without a name are dropped', () => {
    const json = [[{ ...issue123, labels: [{ name: '  Needs-Review ' }, 'Bug', { name: '   ' }, { color: 'fff' }, null, 42] }]]
    expect(parseIssues(json, 'todos', 'acme-corp/todos')[0].labels).toEqual(['needs-review', 'bug'])
  })

  it('an item whose labels are missing or not an array gets labels: []', () => {
    const json = [[{ ...issue123, labels: undefined }, { ...issue123, number: 124, labels: 'impl' }]]
    expect(parseIssues(json, 'todos', 'acme-corp/todos').map((item) => item.labels)).toEqual([[], []])
  })

  it('C44: an author whose user.type is Bot gets author.bot: true', () => {
    const [item] = parseIssues([[pr130]], 'todos', 'acme-corp/todos')
    expect(item.author).toEqual({ login: 'dependabot[bot]', bot: true, association: 'NONE' })
  })

  it('C44: an item with user null and no author_association gets login "" / UNKNOWN without throwing', () => {
    const json = [[{ number: 9, title: 't', html_url: 'https://github.com/acme-corp/todos/issues/9', labels: [{ name: 'impl' }], user: null }, issue123]]
    expect(parseIssues(json, 'todos', 'acme-corp/todos').map((item) => [item.number, item.author])).toEqual([
      [9, { login: '', bot: false, association: 'UNKNOWN' }],
      [123, { login: 'taylor', bot: false, association: 'OWNER' }],
    ])
  })

  it('X1-6: an item with user null, an empty login, or no type is UNKNOWN even when author_association is NONE or OWNER', () => {
    const json = [[
      { ...issue123, number: 1, user: null, author_association: 'NONE' },
      { ...issue123, number: 2, user: { login: '', type: 'User' }, author_association: 'OWNER' },
      { ...issue123, number: 3, user: { login: 'alice' }, author_association: 'OWNER' },
      { ...issue123, number: 4, user: { login: 'alice', type: 'User' }, author_association: 'OWNER' },
    ]]
    expect(parseIssues(json, 'todos', 'acme-corp/todos').map((item) => [item.number, item.author])).toEqual([
      [1, { login: '', bot: false, association: 'UNKNOWN' }],
      [2, { login: '', bot: false, association: 'UNKNOWN' }],
      [3, { login: 'alice', bot: false, association: 'UNKNOWN' }],
      [4, { login: 'alice', bot: false, association: 'OWNER' }],
    ])
  })

  it('C44: an author_association outside the enumeration or in lowercase is UNKNOWN', () => {
    const json = [[{ ...issue123, author_association: 'owner' }, { ...issue123, number: 124, author_association: 'STAFF' }, { ...issue123, number: 125, author_association: 1 }]]
    expect(parseIssues(json, 'todos', 'acme-corp/todos').map((item) => item.author.association)).toEqual(['UNKNOWN', 'UNKNOWN', 'UNKNOWN'])
  })

  it('an item without title / html_url is read as an empty string, and a user.login that is not a string is an empty string', () => {
    const [item] = parseIssues([[{ number: 5, user: { login: 3, type: 'User' } }]], 'todos', 'acme-corp/todos')
    expect(item).toEqual({
      project: 'todos',
      repo: 'acme-corp/todos',
      target: 'issue',
      number: 5,
      title: '',
      url: '',
      labels: [],
      author: { login: '', bot: false, association: 'UNKNOWN' },
    })
  })

  it('an item is an issue when pull_request is null', () => {
    expect(parseIssues([[{ ...issue123, pull_request: null }]], 'todos', 'acme-corp/todos')[0].target).toBe('issue')
  })

  it('drops elements that are not objects and elements whose number is not a positive integer, and returns the rest', () => {
    const json = [[null, 'x', [issue123], { ...issue123, number: '123' }, { ...issue123, number: 0 }, { ...issue123, number: 1.5 }, { title: 'no number' }, pr130]]
    expect(parseIssues(json, 'todos', 'acme-corp/todos').map((item) => item.number)).toEqual([130])
  })

  it('throws when the outer value is not an array of pages', () => {
    expect(() => parseIssues({ message: 'Not Found' }, 'todos', 'acme-corp/todos')).toThrow('acme-corp/todos issues response is not an array of pages')
    expect(() => parseIssues([issue123], 'todos', 'acme-corp/todos')).toThrow('acme-corp/todos issues response is not an array of pages')
  })
})

describe('fetchOpenItems', () => {
  it('puts the account token into GH_TOKEN and reads all pages of open items', async () => {
    replyWith(ghStub({ stdout: JSON.stringify([[issue123], [pr130]]) }))
    const items = await fetchOpenItems(project)
    expect(items.map((item) => [item.target, item.number, item.repo, item.project])).toEqual([
      ['issue', 123, 'acme-corp/todos', 'todos'],
      ['pr', 130, 'acme-corp/todos', 'todos'],
    ])
    expect(calls.map((call) => [call.file, call.args, call.maxBuffer, call.timeout])).toEqual([
      ['gh', ['auth', 'token', '-u', 'taylor', '-h', 'github.com'], 67108864, 60000],
      ['gh', ['api', '--paginate', '--slurp', 'repos/acme-corp/todos/issues?state=open&per_page=100'], 67108864, 60000],
    ])
    expect(calls[1].env?.GH_TOKEN).toBe('gho_test')
    expect(calls[1].env?.PATH).toBe(process.env.PATH)
  })

  it('throws without calling gh api when the token is empty', async () => {
    replyWith(ghStub({ stdout: '[[]]' }, { stdout: '  \n' }))
    await expect(fetchOpenItems(project)).rejects.toThrow('gh auth token returned an empty token (account: taylor)')
    expect(calls.map((call) => call.args[0])).toEqual(['auth'])
  })

  it('a token retrieval failure throws including the gh stderr', async () => {
    replyWith(ghStub({ stdout: '[[]]' }, { error: exitError(1), stderr: 'no oauth token found for github.com account taylor\n' }))
    await expect(fetchOpenItems(project)).rejects.toThrow('gh auth token -u taylor -h github.com failed: no oauth token found for github.com account taylor')
  })

  it('a gh api failure throws including the gh stderr', async () => {
    replyWith(ghStub({ error: exitError(1), stderr: 'gh: Not Found (HTTP 404)\n' }))
    await expect(fetchOpenItems(project)).rejects.toThrow(
      'gh api --paginate --slurp repos/acme-corp/todos/issues?state=open&per_page=100 failed: gh: Not Found (HTTP 404)',
    )
  })

  it('a failure with empty stderr uses the execFile error message', async () => {
    replyWith(ghStub({ error: Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }) }))
    await expect(fetchOpenItems(project)).rejects.toThrow(' failed: stdout maxBuffer length exceeded')
  })

  it('throws as a timeout when gh is stopped for not finishing in 60 seconds (flows into the monitoring error path)', async () => {
    replyWith(ghStub({ error: timeoutError() }))
    await expect(fetchOpenItems(project)).rejects.toThrow('gh api --paginate --slurp repos/acme-corp/todos/issues?state=open&per_page=100 failed: stopped after 60s without finishing')
    replyWith(ghStub({ stdout: '[[]]' }, { error: timeoutError() }))
    await expect(fetchOpenItems(project)).rejects.toThrow('gh auth token -u taylor -h github.com failed: stopped after 60s without finishing')
  })

  it('throws when the response is not JSON', async () => {
    replyWith(ghStub({ stdout: '<html>' }))
    await expect(fetchOpenItems(project)).rejects.toThrow('gh api repos/acme-corp/todos/issues?state=open&per_page=100 response is not JSON')
  })
})

describe('fetchItem', () => {
  it('reads one item and returns an Item in the same shape as parseIssues', async () => {
    replyWith(ghStub({ stdout: JSON.stringify(issue123) }))
    expect(await fetchItem(project, 'issue', 123)).toEqual({
      project: 'todos',
      repo: 'acme-corp/todos',
      target: 'issue',
      number: 123,
      title: 'Feature',
      url: 'https://github.com/acme-corp/todos/issues/123',
      labels: ['impl'],
      author: { login: 'taylor', bot: false, association: 'OWNER' },
    })
    expect(calls.map((call) => [call.args, call.maxBuffer])).toEqual([
      [['auth', 'token', '-u', 'taylor', '-h', 'github.com'], 67108864],
      [['api', 'repos/acme-corp/todos/issues/123'], 67108864],
    ])
    expect(calls[1].env?.GH_TOKEN).toBe('gho_test')
  })

  it('reads a PR as pr', async () => {
    replyWith(ghStub({ stdout: JSON.stringify(pr130) }))
    expect((await fetchItem(project, 'pr', 130)).target).toBe('pr')
  })

  it('throws when target and the presence of pull_request do not match', async () => {
    replyWith(ghStub({ stdout: JSON.stringify(pr130) }))
    await expect(fetchItem(project, 'issue', 130)).rejects.toThrow('acme-corp/todos#130 is not an issue')
    replyWith(ghStub({ stdout: JSON.stringify(issue123) }))
    await expect(fetchItem(project, 'pr', 123)).rejects.toThrow('acme-corp/todos#123 is not a PR')
  })

  it('throws on a response that cannot be read as an item', async () => {
    replyWith(ghStub({ stdout: JSON.stringify({ message: 'Not Found' }) }))
    await expect(fetchItem(project, 'issue', 999)).rejects.toThrow('cannot read acme-corp/todos#999')
  })

  it('a gh api failure throws including stderr', async () => {
    replyWith(ghStub({ error: exitError(1), stderr: 'gh: Not Found (HTTP 404)\n' }))
    await expect(fetchItem(project, 'issue', 999)).rejects.toThrow('gh api repos/acme-corp/todos/issues/999 failed: gh: Not Found (HTTP 404)')
  })
})

describe('listGhAccounts', () => {
  it('when all accounts are healthy, collects the names from the Logged in lines of stdout', async () => {
    replyWith(() => ({
      stdout: [
        'github.com',
        '  ✓ Logged in to github.com account taylor (keyring)',
        '  - Active account: true',
        '',
        '  ✓ Logged in to github.com account acme-developer (keyring)',
        '  - Active account: false',
        '',
      ].join('\n'),
    }))
    expect(await listGhAccounts()).toEqual(['taylor', 'acme-developer'])
    expect(calls.map((call) => [call.file, call.args, call.maxBuffer])).toEqual([['gh', ['auth', 'status'], 67108864]])
  })

  it('reads from stderr even with exit code 1, and does not exclude accounts with authentication problems', async () => {
    replyWith(() => ({
      error: exitError(1),
      stderr: [
        'ghe.example.com',
        '  ✓ Logged in to ghe.example.com account enterprise-user (keyring)',
        'github.com',
        '  ✓ Logged in to github.com account taylor (keyring)',
        '  X Failed to log in to github.com account acme-developer (keyring)',
        '  - The token in keyring is invalid.',
        '  X Timeout trying to log in to github.com account acme-ai-account (keyring)',
        '  X Refresh token for github.com account old-user was rejected',
        '',
      ].join('\n'),
    }))
    expect(await listGhAccounts()).toEqual(['taylor', 'acme-developer', 'acme-ai-account', 'old-user'])
  })

  it('empty when not logged in', async () => {
    replyWith(() => ({ error: exitError(1), stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login\n' }))
    expect(await listGhAccounts()).toEqual([])
  })

  it('throws when gh cannot be launched', async () => {
    replyWith(() => ({ error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) }))
    await expect(listGhAccounts()).rejects.toThrow('cannot run gh auth status: spawn gh ENOENT')
  })

  it('throws when gh auth status does not finish in 60 seconds', async () => {
    replyWith(() => ({ error: timeoutError() }))
    await expect(listGhAccounts()).rejects.toThrow('cannot run gh auth status: stopped after 60s without finishing')
  })
})

describe('fetchRepoIsPrivate', () => {
  it('reads repos/<repo> with the account token and returns private', async () => {
    replyWith(ghStub({ stdout: JSON.stringify({ full_name: 'acme-corp/todos', private: true }) }))
    expect(await fetchRepoIsPrivate(project)).toBe(true)
    expect(calls.map((call) => call.args)).toEqual([
      ['auth', 'token', '-u', 'taylor', '-h', 'github.com'],
      ['api', 'repos/acme-corp/todos'],
    ])
    expect(calls[1].env?.GH_TOKEN).toBe('gho_test')
    replyWith(ghStub({ stdout: JSON.stringify({ private: false }) }))
    expect(await fetchRepoIsPrivate(project)).toBe(false)
  })

  it('throws on a response where private is not a boolean and on a gh api failure', async () => {
    replyWith(ghStub({ stdout: JSON.stringify({ message: 'Not Found' }) }))
    await expect(fetchRepoIsPrivate(project)).rejects.toThrow('gh api repos/acme-corp/todos response has no private field')
    replyWith(ghStub({ error: exitError(1), stderr: 'gh: Not Found (HTTP 404)\n' }))
    await expect(fetchRepoIsPrivate(project)).rejects.toThrow('gh api repos/acme-corp/todos failed: gh: Not Found (HTTP 404)')
  })
})

describe('does not write to GitHub', () => {
  const writeFlags = ['--method', '-X', '-f', '-F', '--raw-field', '--field', '--input']

  it('C50: fetchOpenItems / fetchItem / fetchRepoIsPrivate / listGhAccounts pass no write arguments, and gh api only reads repos/', async () => {
    replyWith((args) => {
      if (args[0] === 'auth' && args[1] === 'token') return { stdout: 'gho_test\n' }
      if (args[0] === 'auth') return { stdout: '  ✓ Logged in to github.com account taylor (keyring)\n' }
      if (args.includes('--slurp')) return { stdout: JSON.stringify([[issue123]]) }
      if (args[1] === 'repos/acme-corp/todos') return { stdout: JSON.stringify({ private: true }) }
      return { stdout: JSON.stringify(issue123) }
    })
    await fetchOpenItems(project)
    await fetchItem(project, 'issue', 123)
    await fetchRepoIsPrivate(project)
    await listGhAccounts()

    expect(calls.map((call) => call.args.slice(0, 2))).toEqual([
      ['auth', 'token'],
      ['api', '--paginate'],
      ['auth', 'token'],
      ['api', 'repos/acme-corp/todos/issues/123'],
      ['auth', 'token'],
      ['api', 'repos/acme-corp/todos'],
      ['auth', 'status'],
    ])
    expect(calls.map((call) => call.timeout)).toEqual([60000, 60000, 60000, 60000, 60000, 60000, 60000])
    expect(calls.flatMap((call) => call.args.filter((arg) => writeFlags.includes(arg) || arg.startsWith('--method=') || /^-[XfF]./.test(arg)))).toEqual([])
    expect(calls.filter((call) => call.args[0] === 'api').map((call) => call.args.slice(1).find((arg) => !arg.startsWith('-')))).toEqual([
      'repos/acme-corp/todos/issues?state=open&per_page=100',
      'repos/acme-corp/todos/issues/123',
      'repos/acme-corp/todos',
    ])
  })
})
