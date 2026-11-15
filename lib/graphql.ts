// A small GraphQL engine for the forge's API surface: a lexer, a parser for
// the query subset the checks use (operations, variables, aliases, fragments,
// enum/list/object literals), a schema table for introspection, and an
// executor that resolves against the same store as REST and MCP.

import {
  ZERO_OID,
  mergeBase,
  parseCommit,
  parseTree,
} from './gitobj.ts';
import {
  VIEWER,
  changedFiles,
  commitTree,
  mergePull,
  nowIso,
  pullMergeability,
  type CommentRec,
  type Forge,
  type IssueRec,
  type LabelRec,
  type PullRec,
  type RepoRec,
  type UserRec,
} from './store.ts';

// ---------------------------------------------------------------- global ids

export function globalId(type: string, dbId: string | number): string {
  return Buffer.from(`${type}:${dbId}`, 'utf8').toString('base64url');
}

function decodeGlobalId(id: string): { type: string; dbId: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    const type = text.slice(0, colon);
    if (!/^[A-Za-z]+$/.test(type)) return null;
    return { type, dbId: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- lexer

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';
interface Token {
  kind: TokenKind;
  value: string;
}

const PUNCT = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|', '&']);

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCT.has(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('Unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          const escapes: Record<string, string> = {
            '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
          };
          if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += escapes[esc] ?? esc;
            j += 2;
          }
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('Unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      let isFloat = false;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      if (source[j] === '.' || source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------- parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: { name: string; value: Value }[];
  selectionSet?: SelectionNode[];
}
type SelectionNode =
  | FieldNode
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition?: string; selectionSet: SelectionNode[] };

interface OperationNode {
  operation: 'query' | 'mutation';
  name?: string;
  variableDefaults: Map<string, Value>;
  selectionSet: SelectionNode[];
}
interface FragmentNode {
  typeCondition: string;
  selectionSet: SelectionNode[];
}
interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`Expected '${value}', found '${token.value}'`);
    }
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`Expected a name, found '${token.value}'`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({
          operation: 'query',
          variableDefaults: new Map(),
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        const variableDefaults = new Map<string, Value>();
        if (this.peek().kind === 'punct' && this.peek().value === '(') {
          this.parseVariableDefinitions(variableDefaults);
        }
        this.skipDirectives();
        operations.push({
          operation: keyword === 'mutation' ? 'mutation' : 'query',
          name,
          variableDefaults,
          selectionSet: this.parseSelectionSet(),
        });
      } else if (keyword === 'fragment') {
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error(`Expected 'on' in fragment definition`);
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`Unexpected definition '${keyword}'`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(defaults: Map<string, Value>): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) defaults.set(name, this.parseValue());
      this.skipDirectives();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseArguments(): { name: string; value: Value }[] {
    const args: { name: string; value: Value }[] = [];
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseValue(): Value {
    const token = this.next();
    switch (token.kind) {
      case 'punct':
        if (token.value === '$') return { kind: 'variable', name: this.expectName() };
        if (token.value === '[') {
          const values: Value[] = [];
          while (!this.skipPunct(']')) values.push(this.parseValue());
          return { kind: 'list', values };
        }
        if (token.value === '{') {
          const fields: { name: string; value: Value }[] = [];
          while (!this.skipPunct('}')) {
            const name = this.expectName();
            this.expectPunct(':');
            fields.push({ name, value: this.parseValue() });
          }
          return { kind: 'object', fields };
        }
        throw new Error(`Unexpected '${token.value}' in value`);
      case 'int':
        return { kind: 'int', value: Number.parseInt(token.value, 10) };
      case 'float':
        return { kind: 'float', value: Number.parseFloat(token.value) };
      case 'string':
        return { kind: 'string', value: token.value };
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      default:
        throw new Error('Unexpected token in value');
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    const selections: SelectionNode[] = [];
    this.expectPunct('{');
    while (!this.skipPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'punct' && this.peek().value === '{') {
        this.skipDirectives();
        return { kind: 'inlineFragment', selectionSet: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.skipDirectives();
      return { kind: 'fragmentSpread', name };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    let args: { name: string; value: Value }[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selectionSet: SelectionNode[] | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selectionSet };
  }
}

// ---------------------------------------------------------------- schema

type TypeKind = 'OBJECT' | 'ENUM' | 'SCALAR' | 'INTERFACE' | 'INPUT_OBJECT';

interface TypeDef {
  kind: TypeKind;
  fields?: Record<string, string>;
  enumValues?: string[];
  inputFields?: Record<string, string>;
}

const CONNECTION = (nodeType: string, edgeType: string): Record<string, string> => ({
  nodes: `[${nodeType}]`,
  edges: `[${edgeType}]`,
  pageInfo: 'PageInfo!',
  totalCount: 'Int!',
});
const EDGE = (nodeType: string): Record<string, string> => ({ node: nodeType, cursor: 'String!' });

export const SCHEMA: Record<string, TypeDef> = {
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Float: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
  DateTime: { kind: 'SCALAR' },
  URI: { kind: 'SCALAR' },
  GitObjectID: { kind: 'SCALAR' },
  HTML: { kind: 'SCALAR' },
  Date: { kind: 'SCALAR' },
  Node: { kind: 'INTERFACE', fields: { id: 'ID!' } },
  Actor: { kind: 'INTERFACE', fields: { login: 'String!' } },
  RepositoryOwner: { kind: 'INTERFACE', fields: { login: 'String!' } },
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: 'User!',
      repository: 'Repository',
      node: 'Node',
      nodes: '[Node]!',
      __type: '__Type',
      __schema: '__Schema',
      rateLimit: 'RateLimit',
      search: 'SearchResultItemConnection!',
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: 'CreateIssuePayload',
      closeIssue: 'CloseIssuePayload',
      reopenIssue: 'ReopenIssuePayload',
      createPullRequest: 'CreatePullRequestPayload',
      mergePullRequest: 'MergePullRequestPayload',
      addComment: 'AddCommentPayload',
    },
  },
  User: {
    kind: 'OBJECT',
    fields: {
      id: 'ID!', login: 'String!', databaseId: 'Int', name: 'String', email: 'String',
      url: 'URI', avatarUrl: 'URI', createdAt: 'DateTime', updatedAt: 'DateTime', isViewer: 'Boolean',
    },
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: 'ID!', databaseId: 'Int', name: 'String!', nameWithOwner: 'String!', owner: 'RepositoryOwner!',
      description: 'String', isPrivate: 'Boolean!', isFork: 'Boolean!', createdAt: 'DateTime!', updatedAt: 'DateTime!',
      defaultBranchRef: 'Branch', viewerPermission: 'RepositoryPermission', hasIssuesEnabled: 'Boolean!',
      hasWikiEnabled: 'Boolean!', url: 'URI', sshUrl: 'String', stargazerCount: 'Int', forkCount: 'Int',
      issue: 'Issue', issues: 'IssueConnection!', pullRequest: 'PullRequest', pullRequests: 'PullRequestConnection!',
      labels: 'LabelConnection', ref: 'Ref', refs: 'RefConnection', object: 'GitObject',
    },
  },
  Branch: { kind: 'OBJECT', fields: { name: 'String!', prefix: 'String!', target: 'Commit' } },
  Ref: { kind: 'OBJECT', fields: { id: 'ID!', name: 'String!', prefix: 'String!', target: 'GitObject' } },
  GitObject: { kind: 'INTERFACE', fields: { id: 'ID!', oid: 'GitObjectID!' } },
  Commit: {
    kind: 'OBJECT',
    fields: {
      id: 'ID!', oid: 'GitObjectID!', message: 'String!', messageHeadline: 'String!',
      committedDate: 'DateTime!', author: 'GitActor', tree: 'Tree!', url: 'URI',
    },
  },
  Tree: { kind: 'OBJECT', fields: { id: 'ID!', oid: 'GitObjectID!', entries: '[TreeEntry!]!' } },
  TreeEntry: { kind: 'OBJECT', fields: { name: 'String!', path: 'String!', type: 'String!', object: 'GitObject' } },
  Blob: { kind: 'OBJECT', fields: { id: 'ID!', oid: 'GitObjectID!', byteSize: 'Int!', text: 'String', isBinary: 'Boolean!' } },
  GitActor: { kind: 'OBJECT', fields: { name: 'String', email: 'String', date: 'DateTime', user: 'User' } },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: 'ID!', databaseId: 'Int', number: 'Int!', title: 'String!', body: 'String', state: 'IssueState!',
      author: 'Actor', labels: 'LabelConnection', comments: 'IssueCommentConnection', repository: 'Repository!',
      createdAt: 'DateTime!', updatedAt: 'DateTime!', closed: 'Boolean!', closedAt: 'DateTime', url: 'URI',
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: 'ID!', databaseId: 'Int', number: 'Int!', title: 'String!', body: 'String', state: 'PullRequestState!',
      merged: 'Boolean!', mergedAt: 'DateTime', mergeCommit: 'Commit', headRefName: 'String!', baseRefName: 'String!',
      headRefOid: 'GitObjectID', baseRefOid: 'GitObjectID', mergeable: 'MergeableState!', author: 'Actor',
      files: 'PullRequestChangedFileConnection', repository: 'Repository!', createdAt: 'DateTime!',
      updatedAt: 'DateTime!', closed: 'Boolean!', closedAt: 'DateTime', url: 'URI',
      additions: 'Int', deletions: 'Int', changedFiles: 'Int',
    },
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: {
      id: 'ID!', databaseId: 'Int', body: 'String!', author: 'Actor',
      createdAt: 'DateTime!', updatedAt: 'DateTime!', url: 'URI',
    },
  },
  Label: {
    kind: 'OBJECT',
    fields: { id: 'ID!', name: 'String!', color: 'String!', description: 'String', url: 'URI', createdAt: 'DateTime', updatedAt: 'DateTime' },
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: { hasNextPage: 'Boolean!', hasPreviousPage: 'Boolean!', startCursor: 'String', endCursor: 'String' },
  },
  IssueConnection: { kind: 'OBJECT', fields: CONNECTION('Issue', 'IssueEdge') },
  IssueEdge: { kind: 'OBJECT', fields: EDGE('Issue') },
  PullRequestConnection: { kind: 'OBJECT', fields: CONNECTION('PullRequest', 'PullRequestEdge') },
  PullRequestEdge: { kind: 'OBJECT', fields: EDGE('PullRequest') },
  LabelConnection: { kind: 'OBJECT', fields: CONNECTION('Label', 'LabelEdge') },
  LabelEdge: { kind: 'OBJECT', fields: EDGE('Label') },
  IssueCommentConnection: { kind: 'OBJECT', fields: CONNECTION('IssueComment', 'IssueCommentEdge') },
  IssueCommentEdge: { kind: 'OBJECT', fields: EDGE('IssueComment') },
  RefConnection: { kind: 'OBJECT', fields: CONNECTION('Ref', 'RefEdge') },
  RefEdge: { kind: 'OBJECT', fields: EDGE('Ref') },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: { nodes: '[PullRequestChangedFile]', totalCount: 'Int', pageInfo: 'PageInfo' },
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: { path: 'String!', additions: 'Int!', deletions: 'Int!', changeType: 'PatchStatus!' },
  },
  SearchResultItemConnection: { kind: 'OBJECT', fields: { nodes: '[SearchResultItem]', issueCount: 'Int!', codeCount: 'Int!', repositoryCount: 'Int!', userCount: 'Int!', discussionCount: 'Int!' } },
  SearchResultItem: { kind: 'OBJECT', fields: {} },
  RateLimit: {
    kind: 'OBJECT',
    fields: { limit: 'Int!', cost: 'Int!', remaining: 'Int!', resetAt: 'DateTime!', nodeCount: 'Int!', used: 'Int!' },
  },
  CreateIssuePayload: { kind: 'OBJECT', fields: { issue: 'Issue', clientMutationId: 'String' } },
  CloseIssuePayload: { kind: 'OBJECT', fields: { issue: 'Issue', clientMutationId: 'String' } },
  ReopenIssuePayload: { kind: 'OBJECT', fields: { issue: 'Issue', clientMutationId: 'String' } },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: 'PullRequest', clientMutationId: 'String' } },
  MergePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: 'PullRequest', clientMutationId: 'String' } },
  AddCommentPayload: { kind: 'OBJECT', fields: { commentEdge: 'IssueCommentEdge', subject: 'Node', clientMutationId: 'String' } },
  CreateIssueInput: {
    kind: 'INPUT_OBJECT',
    inputFields: { repositoryId: 'ID!', title: 'String!', body: 'String', clientMutationId: 'String' },
  },
  CloseIssueInput: { kind: 'INPUT_OBJECT', inputFields: { issueId: 'ID!', clientMutationId: 'String' } },
  ReopenIssueInput: { kind: 'INPUT_OBJECT', inputFields: { issueId: 'ID!', clientMutationId: 'String' } },
  CreatePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: { repositoryId: 'ID!', baseRefName: 'String!', headRefName: 'String!', title: 'String!', body: 'String', clientMutationId: 'String' },
  },
  MergePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: { pullRequestId: 'ID!', mergeMethod: 'PullRequestMergeMethod', clientMutationId: 'String' },
  },
  AddCommentInput: { kind: 'INPUT_OBJECT', inputFields: { subjectId: 'ID!', body: 'String!', clientMutationId: 'String' } },
  IssueOrder: { kind: 'INPUT_OBJECT', inputFields: { field: 'IssueOrderField!', direction: 'OrderDirection!' } },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  PullRequestOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  MergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  PatchStatus: { kind: 'ENUM', enumValues: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'CHANGED', 'UNCHANGED'] },
  __Type: {
    kind: 'OBJECT',
    fields: {
      name: 'String', kind: '__TypeKind!', description: 'String', fields: '[__Field]',
      enumValues: '[__EnumValue]', possibleTypes: '[__Type]', inputFields: '[__InputValue]', ofType: '__Type',
      specifiedByURL: 'String', isOneOf: 'Boolean',
    },
  },
  __Field: {
    kind: 'OBJECT',
    fields: {
      name: 'String!', description: 'String', args: '[__InputValue!]!', type: '__Type!',
      isDeprecated: 'Boolean!', deprecationReason: 'String',
    },
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: { name: 'String!', description: 'String', isDeprecated: 'Boolean!', deprecationReason: 'String' },
  },
  __InputValue: {
    kind: 'OBJECT',
    fields: { name: 'String!', description: 'String', type: '__Type!', defaultValue: 'String', isDeprecated: 'Boolean!', deprecationReason: 'String' },
  },
  __Schema: {
    kind: 'OBJECT',
    fields: {
      types: '[__Type!]!', queryType: '__Type!', mutationType: '__Type',
      subscriptionType: '__Type', directives: '[__Directive!]!', description: 'String',
    },
  },
  __Directive: {
    kind: 'OBJECT',
    fields: { name: 'String!', description: 'String', locations: '[__DirectiveLocation!]!', args: '[__InputValue!]!', isRepeatable: 'Boolean!' },
  },
  __TypeKind: { kind: 'ENUM', enumValues: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'] },
  __DirectiveLocation: {
    kind: 'ENUM',
    enumValues: ['QUERY', 'MUTATION', 'SUBSCRIPTION', 'FIELD', 'FRAGMENT_DEFINITION', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT', 'SCHEMA', 'SCALAR', 'OBJECT', 'FIELD_DEFINITION', 'ARGUMENT_DEFINITION', 'INTERFACE', 'UNION', 'ENUM', 'ENUM_VALUE', 'INPUT_OBJECT', 'INPUT_FIELD_DEFINITION', 'VARIABLE_DEFINITION'],
  },
};

/** Declared arguments for the fields the checks are likeliest to introspect. */
const FIELD_ARGS: Record<string, Record<string, string>> = {
  'Query.repository': { owner: 'String!', name: 'String!' },
  'Query.node': { id: 'ID!' },
  'Query.nodes': { ids: '[ID!]!' },
  'Query.__type': { name: 'String!' },
  'Query.search': { query: 'String!', type: 'SearchType!', first: 'Int', after: 'String' },
  'Repository.issue': { number: 'Int!' },
  'Repository.issues': { first: 'Int', after: 'String', states: '[IssueState!]', orderBy: 'IssueOrder' },
  'Repository.pullRequest': { number: 'Int!' },
  'Repository.pullRequests': { first: 'Int', after: 'String', states: '[PullRequestState!]' },
  'Repository.labels': { first: 'Int', after: 'String' },
  'Repository.ref': { qualifiedName: 'String!' },
  'Repository.refs': { first: 'Int', after: 'String', refPrefix: 'String!' },
  'Repository.object': { expression: 'String!' },
  'Issue.comments': { first: 'Int', after: 'String' },
  'Issue.labels': { first: 'Int', after: 'String' },
  'PullRequest.files': { first: 'Int', after: 'String' },
  '__Type.fields': { includeDeprecated: 'Boolean' },
  '__Type.enumValues': { includeDeprecated: 'Boolean' },
  'Mutation.createIssue': { input: 'CreateIssueInput!' },
  'Mutation.closeIssue': { input: 'CloseIssueInput!' },
  'Mutation.reopenIssue': { input: 'ReopenIssueInput!' },
  'Mutation.createPullRequest': { input: 'CreatePullRequestInput!' },
  'Mutation.mergePullRequest': { input: 'MergePullRequestInput!' },
  'Mutation.addComment': { input: 'AddCommentInput!' },
};

interface TypeRefObj {
  __gqlTypeRef: true;
  kind: string;
  name: string | null;
  ofType?: TypeRefObj;
}

function typeRefFromString(text: string): TypeRefObj {
  let rest = text.trim();
  let nonNull = false;
  if (rest.endsWith('!')) {
    nonNull = true;
    rest = rest.slice(0, -1).trim();
  }
  let ref: TypeRefObj;
  if (rest.startsWith('[') && rest.endsWith(']')) {
    ref = { __gqlTypeRef: true, kind: 'LIST', name: null, ofType: typeRefFromString(rest.slice(1, -1)) };
  } else {
    const def = SCHEMA[rest];
    ref = { __gqlTypeRef: true, kind: def?.kind ?? 'SCALAR', name: rest };
  }
  if (nonNull) return { __gqlTypeRef: true, kind: 'NON_NULL', name: null, ofType: ref };
  return ref;
}

function typeObjectByName(name: string): GqlObj {
  return { __type: '__Type', typeName: name };
}

// ---------------------------------------------------------------- object model

type GqlObj = { __type: string; [key: string]: unknown };

function userObj(user: UserRec): GqlObj {
  return { __type: 'User', user };
}
function repoObj(repo: RepoRec): GqlObj {
  return { __type: 'Repository', repo };
}
function issueObj(repo: RepoRec, issue: IssueRec): GqlObj {
  return { __type: 'Issue', repo, issue };
}
function pullObj(repo: RepoRec, pull: PullRec): GqlObj {
  return { __type: 'PullRequest', repo, pull };
}
function commentObj(repo: RepoRec, comment: CommentRec): GqlObj {
  return { __type: 'IssueComment', repo, comment };
}
function labelObj(repo: RepoRec, label: LabelRec): GqlObj {
  return { __type: 'Label', repo, label };
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

function indexFromCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : Number.parseInt(match[1] as string, 10);
  } catch {
    return -1;
  }
}

interface ConnectionArgs {
  first?: number;
  after?: string;
}

function connectionObj(type: string, items: GqlObj[], args: ConnectionArgs): GqlObj {
  const start = args.after !== undefined ? indexFromCursor(args.after) + 1 : 0;
  const first = typeof args.first === 'number' && args.first >= 0 ? args.first : items.length;
  const slice = items.slice(start, start + first);
  const edges = slice.map((node, offset) => ({
    __type: type.replace('Connection', 'Edge'),
    node,
    cursor: cursorFor(start + offset),
  }));
  const pageInfo: GqlObj = {
    __type: 'PageInfo',
    hasNextPage: start + slice.length < items.length,
    hasPreviousPage: start > 0,
    startCursor: slice.length > 0 ? cursorFor(start) : null,
    endCursor: slice.length > 0 ? cursorFor(start + slice.length - 1) : null,
  };
  return { __type: type, nodesArr: slice, edgesArr: edges, pageInfoObj: pageInfo, total: items.length };
}

class GqlFailure extends Error {}

interface Ctx {
  forge: Forge;
  variables: Map<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: { message: string }[];
}

function valueOf(ctx: Ctx, value: Value, defaults: Map<string, Value>): unknown {
  switch (value.kind) {
    case 'variable': {
      if (ctx.variables.has(value.name)) return ctx.variables.get(value.name);
      const fallback = defaults.get(value.name);
      return fallback === undefined ? undefined : valueOf(ctx, fallback, defaults);
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((item) => valueOf(ctx, item, defaults));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = valueOf(ctx, field.value, defaults);
      return out;
    }
  }
}

function argsOf(ctx: Ctx, field: FieldNode, defaults: Map<string, Value>): Map<string, unknown> {
  const args = new Map<string, unknown>();
  for (const arg of field.args) args.set(arg.name, valueOf(ctx, arg.value, defaults));
  return args;
}

function inputOf(args: Map<string, unknown>): Record<string, unknown> {
  const input = args.get('input');
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of args) out[key] = value;
  return out;
}

function asInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function findIssueByNodeId(forge: Forge, dbId: string): { repo: RepoRec; issue: IssueRec } | null {
  const id = Number.parseInt(dbId, 10);
  if (!Number.isInteger(id)) return null;
  for (const repo of forge.repos.values()) {
    for (const issue of repo.issues.values()) {
      if (issue.id === id) return { repo, issue };
    }
  }
  return null;
}

function findPullByNodeId(forge: Forge, dbId: string): { repo: RepoRec; pull: PullRec } | null {
  const id = Number.parseInt(dbId, 10);
  if (!Number.isInteger(id)) return null;
  for (const repo of forge.repos.values()) {
    for (const pull of repo.pulls.values()) {
      if (pull.id === id) return { repo, pull };
    }
  }
  return null;
}

function nodeByGlobalId(forge: Forge, id: string): GqlObj | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  switch (decoded.type) {
    case 'Repository': {
      const repoId = Number.parseInt(decoded.dbId, 10);
      for (const repo of forge.repos.values()) if (repo.id === repoId) return repoObj(repo);
      return null;
    }
    case 'Issue': {
      const found = findIssueByNodeId(forge, decoded.dbId);
      return found === null ? null : issueObj(found.repo, found.issue);
    }
    case 'PullRequest': {
      const found = findPullByNodeId(forge, decoded.dbId);
      return found === null ? null : pullObj(found.repo, found.pull);
    }
    case 'User': {
      const userId = Number.parseInt(decoded.dbId, 10);
      for (const user of forge.users.values()) if (user.id === userId) return userObj(user);
      return null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------- resolvers

function resolveQuery(ctx: Ctx, field: string, args: Map<string, unknown>): unknown {
  const forge = ctx.forge;
  switch (field) {
    case 'viewer':
      return userObj(VIEWER);
    case 'repository': {
      const owner = asString(args.get('owner'));
      const name = asString(args.get('name'));
      if (owner === undefined || name === undefined) return null;
      const repo = forge.getRepo(owner, name);
      return repo === undefined ? null : repoObj(repo);
    }
    case 'node': {
      const id = asString(args.get('id'));
      return id === undefined ? null : nodeByGlobalId(forge, id);
    }
    case 'nodes': {
      const ids = args.get('ids');
      if (!Array.isArray(ids)) return [];
      return ids.map((id) => (typeof id === 'string' ? nodeByGlobalId(forge, id) : null));
    }
    case '__type': {
      const name = asString(args.get('name'));
      if (name === undefined || SCHEMA[name] === undefined) return null;
      return typeObjectByName(name);
    }
    case '__schema':
      return { __type: '__Schema' };
    case 'rateLimit':
      return {
        __type: 'RateLimit', limit: 5000, cost: 1, remaining: 4999,
        resetAt: '2030-01-01T00:00:00Z', nodeCount: 0, used: 1,
      };
    case 'search':
      return {
        __type: 'SearchResultItemConnection', nodesArr: [], edgesArr: [],
        pageInfoObj: { __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
        total: 0, issueCount: 0, codeCount: 0, repositoryCount: 0, userCount: 0, discussionCount: 0,
      };
    default:
      return undefined;
  }
}

function resolveMutation(ctx: Ctx, field: string, args: Map<string, unknown>): unknown {
  const forge = ctx.forge;
  const input = inputOf(args);
  const clientMutationId = asString(input.clientMutationId) ?? null;
  switch (field) {
    case 'createIssue': {
      const repoId = asString(input.repositoryId);
      const repoNode = repoId === undefined ? null : nodeByGlobalId(forge, repoId);
      if (repoNode === null || repoNode.__type !== 'Repository') {
        throw new GqlFailure('Repository not found');
      }
      const repo = repoNode.repo as RepoRec;
      const title = asString(input.title);
      if (title === undefined || title === '') throw new GqlFailure('Title is required');
      const issue: IssueRec = {
        kind: 'issue',
        id: forge.nextNodeId(),
        number: repo.nextNumber,
        title,
        body: asString(input.body) ?? '',
        state: 'open',
        labels: [],
        user: VIEWER.login,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        comments: [],
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      repo.updatedAt = nowIso();
      return { __type: 'CreateIssuePayload', issue: issueObj(repo, issue), clientMutationId };
    }
    case 'closeIssue':
    case 'reopenIssue': {
      const issueId = asString(input.issueId);
      const found = issueId === undefined ? null : (() => {
        const decoded = decodeGlobalId(issueId);
        return decoded === null ? null : findIssueByNodeId(forge, decoded.dbId);
      })();
      if (found === null) throw new GqlFailure('Issue not found');
      found.issue.state = field === 'closeIssue' ? 'closed' : 'open';
      found.issue.updatedAt = nowIso();
      return {
        __type: field === 'closeIssue' ? 'CloseIssuePayload' : 'ReopenIssuePayload',
        issue: issueObj(found.repo, found.issue),
        clientMutationId,
      };
    }
    case 'createPullRequest': {
      const repoId = asString(input.repositoryId);
      const repoNode = repoId === undefined ? null : nodeByGlobalId(forge, repoId);
      if (repoNode === null || repoNode.__type !== 'Repository') {
        throw new GqlFailure('Repository not found');
      }
      const repo = repoNode.repo as RepoRec;
      const head = asString(input.headRefName);
      const base = asString(input.baseRefName);
      const title = asString(input.title);
      if (head === undefined || base === undefined || title === undefined) {
        throw new GqlFailure('baseRefName, headRefName and title are required');
      }
      if (repo.refs.get(`refs/heads/${head}`) === undefined) throw new GqlFailure(`Head branch ${head} does not exist`);
      if (repo.refs.get(`refs/heads/${base}`) === undefined) throw new GqlFailure(`Base branch ${base} does not exist`);
      const pull: PullRec = {
        kind: 'pull',
        id: forge.nextNodeId(),
        number: repo.nextNumber,
        title,
        body: asString(input.body) ?? '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        user: VIEWER.login,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        comments: [],
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      repo.updatedAt = nowIso();
      return { __type: 'CreatePullRequestPayload', pullRequest: pullObj(repo, pull), clientMutationId };
    }
    case 'mergePullRequest': {
      const pullId = asString(input.pullRequestId);
      const decoded = pullId === undefined ? null : decodeGlobalId(pullId);
      const found = decoded === null ? null : findPullByNodeId(forge, decoded.dbId);
      if (found === null) throw new GqlFailure('Pull request not found');
      const methodRaw = (asString(input.mergeMethod) ?? 'SQUASH').toUpperCase();
      const method = methodRaw === 'MERGE' ? 'merge' : methodRaw === 'REBASE' ? 'rebase' : 'squash';
      if (found.pull.state === 'open' && !found.pull.merged) {
        const sha = mergePull(found.repo, found.pull, method);
        if (sha === null) throw new GqlFailure('Pull Request is not mergeable: merge conflict');
      }
      return { __type: 'MergePullRequestPayload', pullRequest: pullObj(found.repo, found.pull), clientMutationId };
    }
    case 'addComment': {
      const subjectId = asString(input.subjectId);
      const body = asString(input.body);
      if (subjectId === undefined || body === undefined) throw new GqlFailure('subjectId and body are required');
      const subject = nodeByGlobalId(forge, subjectId);
      if (subject === null || (subject.__type !== 'Issue' && subject.__type !== 'PullRequest')) {
        throw new GqlFailure('Subject not found');
      }
      const repo = subject.repo as RepoRec;
      const host = (subject.__type === 'Issue' ? subject.issue : subject.pull) as IssueRec | PullRec;
      const comment: CommentRec = {
        id: forge.nextCommentId(),
        body,
        user: VIEWER.login,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      host.comments.push(comment);
      host.updatedAt = nowIso();
      const edge: GqlObj = {
        __type: 'IssueCommentEdge',
        node: commentObj(repo, comment),
        cursor: cursorFor(host.comments.length - 1),
      };
      return { __type: 'AddCommentPayload', commentEdge: edge, subject, clientMutationId };
    }
    default:
      return undefined;
  }
}

function resolveRepository(ctx: Ctx, obj: GqlObj, field: string, args: Map<string, unknown>): unknown {
  const repo = obj.repo as RepoRec;
  switch (field) {
    case 'id': return globalId('Repository', repo.id);
    case 'databaseId': return repo.id;
    case 'name': return repo.name;
    case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
    case 'owner': return userObj(ctx.forge.users.get(repo.owner) ?? VIEWER);
    case 'description': return repo.description;
    case 'isPrivate': return repo.private;
    case 'isFork': return false;
    case 'createdAt': return repo.createdAt;
    case 'updatedAt': return repo.updatedAt;
    case 'defaultBranchRef': {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (tip === undefined) return null;
      return { __type: 'Branch', repo, name: repo.defaultBranch, oid: tip };
    }
    case 'viewerPermission': return 'ADMIN';
    case 'hasIssuesEnabled': return true;
    case 'hasWikiEnabled': return true;
    case 'url': return '';
    case 'sshUrl': return '';
    case 'stargazerCount': return 0;
    case 'forkCount': return 0;
    case 'issue': {
      const number = asInt(args.get('number'));
      const issue = number === undefined ? undefined : repo.issues.get(number);
      return issue === undefined ? null : issueObj(repo, issue);
    }
    case 'issues': {
      const states = args.get('states');
      let list = [...repo.issues.values()];
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        list = list.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = args.get('orderBy') as { direction?: string } | undefined;
      const descending = orderBy?.direction === 'DESC';
      list.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
      return connectionObj('IssueConnection', list.map((issue) => issueObj(repo, issue)), {
        first: asInt(args.get('first')),
        after: asString(args.get('after')),
      });
    }
    case 'pullRequest': {
      const number = asInt(args.get('number'));
      const pull = number === undefined ? undefined : repo.pulls.get(number);
      return pull === undefined ? null : pullObj(repo, pull);
    }
    case 'pullRequests': {
      const states = args.get('states');
      let list = [...repo.pulls.values()];
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => String(state).toUpperCase()));
        list = list.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
      }
      list.sort((a, b) => a.number - b.number);
      return connectionObj('PullRequestConnection', list.map((pull) => pullObj(repo, pull)), {
        first: asInt(args.get('first')),
        after: asString(args.get('after')),
      });
    }
    case 'labels': {
      const labels = [...repo.labels.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
      return connectionObj('LabelConnection', labels.map((label) => labelObj(repo, label)), {
        first: asInt(args.get('first')),
        after: asString(args.get('after')),
      });
    }
    case 'ref': {
      const qualified = asString(args.get('qualifiedName')) ?? '';
      const oid = repo.refs.get(qualified);
      if (oid === undefined) return null;
      const name = qualified.replace(/^refs\/(heads|tags)\//, '');
      const prefix = qualified.slice(0, qualified.length - name.length);
      return { __type: 'Ref', repo, name, prefix, oid };
    }
    case 'refs': {
      const prefix = asString(args.get('refPrefix')) ?? 'refs/';
      const refs = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([ref, oid]) => {
          const name = ref.slice(prefix.length);
          return { __type: 'Ref', repo, name, prefix, oid } as GqlObj;
        });
      return connectionObj('RefConnection', refs, {
        first: asInt(args.get('first')),
        after: asString(args.get('after')),
      });
    }
    case 'object': {
      const expression = asString(args.get('expression')) ?? '';
      const oid = expression === '' ? undefined : resolveExpression(repo, expression);
      if (oid === undefined) return null;
      const object = repo.store.get(oid);
      if (object === undefined) return null;
      if (object.type === 'commit') return { __type: 'Commit', repo, oid };
      if (object.type === 'tree') return { __type: 'Tree', repo, oid };
      if (object.type === 'blob') return { __type: 'Blob', repo, oid };
      return null;
    }
    default:
      return undefined;
  }
}

function resolveExpression(repo: RepoRec, expression: string): string | undefined {
  const branch = repo.refs.get(`refs/heads/${expression}`);
  if (branch !== undefined) return branch;
  const tag = repo.refs.get(`refs/tags/${expression}`);
  if (tag !== undefined) return tag;
  const direct = repo.refs.get(expression);
  if (direct !== undefined) return direct;
  if (/^[0-9a-f]{40}$/i.test(expression) && repo.store.has(expression.toLowerCase())) {
    return expression.toLowerCase();
  }
  if (expression === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return undefined;
}

function resolveIssue(ctx: Ctx, obj: GqlObj, field: string, args: Map<string, unknown>): unknown {
  const repo = obj.repo as RepoRec;
  const issue = obj.issue as IssueRec;
  switch (field) {
    case 'id': return globalId('Issue', issue.id);
    case 'databaseId': return issue.id;
    case 'number': return issue.number;
    case 'title': return issue.title;
    case 'body': return issue.body;
    case 'state': return issue.state.toUpperCase();
    case 'author': return userObj(ctx.forge.users.get(issue.user) ?? VIEWER);
    case 'labels': {
      const labels = issue.labels
        .map((name) => repo.labels.get(name))
        .filter((label): label is LabelRec => label !== undefined);
      return connectionObj('LabelConnection', labels.map((label) => labelObj(repo, label)), {
        first: asInt(args.get('first')),
        after: asString(args.get('after')),
      });
    }
    case 'comments': {
      return connectionObj('IssueCommentConnection', issue.comments.map((comment) => commentObj(repo, comment)), {
        first: asInt(args.get('first')),
        after: asString(args.get('after')),
      });
    }
    case 'repository': return repoObj(repo);
    case 'createdAt': return issue.createdAt;
    case 'updatedAt': return issue.updatedAt;
    case 'closed': return issue.state === 'closed';
    case 'closedAt': return issue.state === 'closed' ? issue.updatedAt : null;
    case 'url': return '';
    default: return undefined;
  }
}

function pullState(pull: PullRec): string {
  if (pull.merged) return 'MERGED';
  return pull.state.toUpperCase();
}

function resolvePull(ctx: Ctx, obj: GqlObj, field: string, args: Map<string, unknown>): unknown {
  const repo = obj.repo as RepoRec;
  const pull = obj.pull as PullRec;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  switch (field) {
    case 'id': return globalId('PullRequest', pull.id);
    case 'databaseId': return pull.id;
    case 'number': return pull.number;
    case 'title': return pull.title;
    case 'body': return pull.body;
    case 'state': return pullState(pull);
    case 'merged': return pull.merged;
    case 'mergedAt': return pull.mergedAt;
    case 'mergeCommit':
      return pull.mergeCommitSha === null ? null : { __type: 'Commit', repo, oid: pull.mergeCommitSha };
    case 'headRefName': return pull.headRef;
    case 'baseRefName': return pull.baseRef;
    case 'headRefOid': return headTip ?? null;
    case 'baseRefOid': return baseTip ?? null;
    case 'mergeable': return pull.state === 'open' ? pullMergeability(repo, pull) : 'UNKNOWN';
    case 'author': return userObj(ctx.forge.users.get(pull.user) ?? VIEWER);
    case 'files': {
      const emptyPageInfo: GqlObj = {
        __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null,
      };
      if (headTip === undefined || baseTip === undefined) {
        return { __type: 'PullRequestChangedFileConnection', nodesArr: [], total: 0, pageInfoObj: emptyPageInfo };
      }
      const base = mergeBase(repo.store, baseTip, headTip) ?? baseTip;
      const changes = changedFiles(repo.store, commitTree(repo.store, base), commitTree(repo.store, headTip));
      const nodes = changes.map((change) => ({
        __type: 'PullRequestChangedFile',
        path: change.path,
        additions: change.additions,
        deletions: change.deletions,
        changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'DELETED' : 'MODIFIED',
      }));
      const first = asInt(args.get('first'));
      return {
        __type: 'PullRequestChangedFileConnection',
        nodesArr: first === undefined ? nodes : nodes.slice(0, first),
        total: nodes.length,
        pageInfoObj: emptyPageInfo,
      };
    }
    case 'repository': return repoObj(repo);
    case 'createdAt': return pull.createdAt;
    case 'updatedAt': return pull.updatedAt;
    case 'closed': return pull.state === 'closed';
    case 'closedAt': return pull.state === 'closed' ? pull.updatedAt : null;
    case 'url': return '';
    case 'additions': return 0;
    case 'deletions': return 0;
    case 'changedFiles': return 0;
    default: return undefined;
  }
}

function resolveCommit(repo: RepoRec, oid: string, field: string): unknown {
  const object = repo.store.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  switch (field) {
    case 'id': return globalId('Commit', oid);
    case 'oid': return oid;
    case 'message': return commit.message.replace(/\n$/, '');
    case 'messageHeadline': return commit.message.split('\n')[0] ?? '';
    case 'committedDate': {
      const match = /(\d+) [+-]\d{4}$/.exec(commit.committer);
      return match === null ? repo.createdAt : new Date(Number(match[1]) * 1000).toISOString();
    }
    case 'author': {
      const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(commit.author);
      return {
        __type: 'GitActor',
        name: match?.[1] ?? '',
        email: match?.[2] ?? '',
        date: match === null ? null : new Date(Number(match[3]) * 1000).toISOString(),
        userLogin: null,
      };
    }
    case 'tree': return { __type: 'Tree', repo, oid: commit.tree };
    case 'url': return '';
    default: return undefined;
  }
}

function resolveTypeObject(obj: GqlObj, field: string, args: Map<string, unknown>): unknown {
  if (obj.__type === '__Type') {
    const name = obj.typeName as string | null;
    switch (field) {
      case 'name': return name;
      case 'kind': {
        if (obj.refKind !== undefined) return obj.refKind;
        if (name === null) return null;
        return SCHEMA[name]?.kind ?? 'SCALAR';
      }
      case 'description': return null;
      case 'ofType': {
        const ofType = obj.ofType as TypeRefObj | undefined;
        if (ofType === undefined) return null;
        return {
          __type: '__Type',
          typeName: ofType.name,
          refKind: ofType.kind,
          ofType: ofType.ofType,
        };
      }
      case 'fields': {
        if (name === null) return null;
        const def = SCHEMA[name];
        if (def === undefined || def.fields === undefined) return null;
        return Object.entries(def.fields).map(([fieldName, typeText]) => ({
          __type: '__Field',
          fieldName,
          ownerType: name,
          fieldType: typeRefFromString(typeText),
        }));
      }
      case 'enumValues': {
        if (name === null) return null;
        const def = SCHEMA[name];
        if (def === undefined || def.enumValues === undefined) return null;
        return def.enumValues.map((valueName) => ({ __type: '__EnumValue', valueName }));
      }
      case 'inputFields': {
        if (name === null) return null;
        const def = SCHEMA[name];
        if (def === undefined || def.inputFields === undefined) return null;
        return Object.entries(def.inputFields).map(([inputName, typeText]) => ({
          __type: '__InputValue',
          inputName,
          inputType: typeRefFromString(typeText),
        }));
      }
      case 'possibleTypes': {
        if (name === 'Node') {
          return ['Repository', 'Issue', 'PullRequest', 'User', 'IssueComment', 'Label', 'Commit', 'Tree', 'Blob', 'Ref']
            .map(typeObjectByName);
        }
        if (name === 'Actor' || name === 'RepositoryOwner') return [typeObjectByName('User')];
        if (name === 'GitObject') return ['Commit', 'Tree', 'Blob'].map(typeObjectByName);
        return null;
      }
      case 'specifiedByURL': return null;
      case 'isOneOf': return false;
      default: return undefined;
    }
  }
  if (obj.__type === '__Field') {
    switch (field) {
      case 'name': return obj.fieldName;
      case 'description': return null;
      case 'type': {
        const ref = obj.fieldType as TypeRefObj;
        return { __type: '__Type', typeName: ref.name, refKind: ref.kind, ofType: ref.ofType };
      }
      case 'args': {
        const declared = FIELD_ARGS[`${obj.ownerType as string}.${obj.fieldName as string}`] ?? {};
        return Object.entries(declared).map(([argName, typeText]) => ({
          __type: '__InputValue',
          inputName: argName,
          inputType: typeRefFromString(typeText),
        }));
      }
      case 'isDeprecated': return false;
      case 'deprecationReason': return null;
      default: return undefined;
    }
  }
  if (obj.__type === '__EnumValue') {
    switch (field) {
      case 'name': return obj.valueName;
      case 'description': return null;
      case 'isDeprecated': return false;
      case 'deprecationReason': return null;
      default: return undefined;
    }
  }
  if (obj.__type === '__InputValue') {
    switch (field) {
      case 'name': return obj.inputName;
      case 'description': return null;
      case 'type': {
        const ref = obj.inputType as TypeRefObj;
        return { __type: '__Type', typeName: ref.name, refKind: ref.kind, ofType: ref.ofType };
      }
      case 'defaultValue': return null;
      case 'isDeprecated': return false;
      case 'deprecationReason': return null;
      default: return undefined;
    }
  }
  if (obj.__type === '__Schema') {
    switch (field) {
      case 'types': return Object.keys(SCHEMA).map(typeObjectByName);
      case 'queryType': return typeObjectByName('Query');
      case 'mutationType': return typeObjectByName('Mutation');
      case 'subscriptionType': return null;
      case 'directives': return [];
      case 'description': return null;
      default: return undefined;
    }
  }
  return undefined;
}

function resolveField(ctx: Ctx, obj: GqlObj, field: string, args: Map<string, unknown>): unknown {
  switch (obj.__type) {
    case 'Query': return resolveQuery(ctx, field, args);
    case 'Mutation': return resolveMutation(ctx, field, args);
    case 'User': {
      const user = obj.user as UserRec;
      switch (field) {
        case 'id': return globalId('User', user.id);
        case 'databaseId': return user.id;
        case 'login': return user.login;
        case 'name': return user.name;
        case 'email': return user.email;
        case 'url': return '';
        case 'avatarUrl': return '';
        case 'createdAt': return '2020-01-01T00:00:00Z';
        case 'updatedAt': return '2020-01-01T00:00:00Z';
        case 'isViewer': return user.login === VIEWER.login;
        default: return undefined;
      }
    }
    case 'Repository': return resolveRepository(ctx, obj, field, args);
    case 'Issue': return resolveIssue(ctx, obj, field, args);
    case 'PullRequest': return resolvePull(ctx, obj, field, args);
    case 'IssueComment': {
      const comment = obj.comment as CommentRec;
      switch (field) {
        case 'id': return globalId('IssueComment', comment.id);
        case 'databaseId': return comment.id;
        case 'body': return comment.body;
        case 'author': return userObj(ctx.forge.users.get(comment.user) ?? VIEWER);
        case 'createdAt': return comment.createdAt;
        case 'updatedAt': return comment.updatedAt;
        case 'url': return '';
        default: return undefined;
      }
    }
    case 'Label': {
      const repo = obj.repo as RepoRec;
      const label = obj.label as LabelRec;
      switch (field) {
        case 'id': return globalId('Label', `${repo.id}:${label.name}`);
        case 'name': return label.name;
        case 'color': return label.color;
        case 'description': return label.description;
        case 'url': return '';
        case 'createdAt': return null;
        case 'updatedAt': return null;
        default: return undefined;
      }
    }
    case 'Branch': {
      const repo = obj.repo as RepoRec;
      switch (field) {
        case 'name': return obj.name;
        case 'prefix': return 'refs/heads/';
        case 'target': return { __type: 'Commit', repo, oid: obj.oid };
        default: return undefined;
      }
    }
    case 'Ref': {
      const repo = obj.repo as RepoRec;
      switch (field) {
        case 'id': return globalId('Ref', `${repo.id}:${obj.prefix as string}${obj.name as string}`);
        case 'name': return obj.name;
        case 'prefix': return obj.prefix;
        case 'target': {
          const object = repo.store.get(obj.oid as string);
          if (object === undefined) return null;
          if (object.type === 'commit') return { __type: 'Commit', repo, oid: obj.oid };
          if (object.type === 'tree') return { __type: 'Tree', repo, oid: obj.oid };
          if (object.type === 'blob') return { __type: 'Blob', repo, oid: obj.oid };
          return null;
        }
        default: return undefined;
      }
    }
    case 'Commit': return resolveCommit(obj.repo as RepoRec, obj.oid as string, field);
    case 'Tree': {
      const repo = obj.repo as RepoRec;
      const oid = obj.oid as string;
      switch (field) {
        case 'id': return globalId('Tree', oid);
        case 'oid': return oid;
        case 'entries': {
          const object = repo.store.get(oid);
          if (object === undefined || object.type !== 'tree') return [];
          return parseTree(object.data).map((entry) => ({
            __type: 'TreeEntry',
            repo,
            name: entry.name,
            path: entry.name,
            entryType: entry.type,
            entryOid: entry.oid,
          }));
        }
        default: return undefined;
      }
    }
    case 'TreeEntry': {
      const repo = obj.repo as RepoRec;
      switch (field) {
        case 'name': return obj.name;
        case 'path': return obj.path;
        case 'type': return obj.entryType;
        case 'object': {
          const object = repo.store.get(obj.entryOid as string);
          if (object === undefined) return null;
          if (object.type === 'tree') return { __type: 'Tree', repo, oid: obj.entryOid };
          if (object.type === 'blob') return { __type: 'Blob', repo, oid: obj.entryOid };
          if (object.type === 'commit') return { __type: 'Commit', repo, oid: obj.entryOid };
          return null;
        }
        default: return undefined;
      }
    }
    case 'Blob': {
      const repo = obj.repo as RepoRec;
      const oid = obj.oid as string;
      const object = repo.store.get(oid);
      const data = object?.data ?? Buffer.alloc(0);
      switch (field) {
        case 'id': return globalId('Blob', oid);
        case 'oid': return oid;
        case 'byteSize': return data.length;
        case 'text': return data.toString('utf8');
        case 'isBinary': return false;
        default: return undefined;
      }
    }
    case 'GitActor': {
      switch (field) {
        case 'name': return obj.name;
        case 'email': return obj.email;
        case 'date': return obj.date;
        case 'user': return null;
        default: return undefined;
      }
    }
    case 'PullRequestChangedFile':
      switch (field) {
        case 'path': return obj.path;
        case 'additions': return obj.additions;
        case 'deletions': return obj.deletions;
        case 'changeType': return obj.changeType;
        default: return undefined;
      }
    case 'PageInfo':
      switch (field) {
        case 'hasNextPage': return obj.hasNextPage;
        case 'hasPreviousPage': return obj.hasPreviousPage;
        case 'startCursor': return obj.startCursor;
        case 'endCursor': return obj.endCursor;
        default: return undefined;
      }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
    case 'ReopenIssuePayload':
      switch (field) {
        case 'issue': return obj.issue;
        case 'clientMutationId': return obj.clientMutationId;
        default: return undefined;
      }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      switch (field) {
        case 'pullRequest': return obj.pullRequest;
        case 'clientMutationId': return obj.clientMutationId;
        default: return undefined;
      }
    case 'AddCommentPayload':
      switch (field) {
        case 'commentEdge': return obj.commentEdge;
        case 'subject': return obj.subject;
        case 'clientMutationId': return obj.clientMutationId;
        default: return undefined;
      }
    case '__Type':
    case '__Field':
    case '__EnumValue':
    case '__InputValue':
    case '__Schema':
      return resolveTypeObject(obj, field, args);
    default: {
      // Connection and edge shapes are stored precomputed on the object.
      if (obj.__type.endsWith('Connection')) {
        switch (field) {
          case 'nodes': return obj.nodesArr;
          case 'edges': return obj.edgesArr;
          case 'pageInfo': return obj.pageInfoObj;
          case 'totalCount': return obj.total;
          case 'issueCount': return obj.issueCount ?? 0;
          case 'codeCount': return obj.codeCount ?? 0;
          case 'repositoryCount': return obj.repositoryCount ?? 0;
          case 'userCount': return obj.userCount ?? 0;
          case 'discussionCount': return obj.discussionCount ?? 0;
          default: return undefined;
        }
      }
      if (obj.__type.endsWith('Edge')) {
        switch (field) {
          case 'node': return obj.node;
          case 'cursor': return obj.cursor;
          default: return undefined;
        }
      }
      return undefined;
    }
  }
}

// ---------------------------------------------------------------- executor

function typeMatches(objType: string, condition: string | undefined): boolean {
  if (condition === undefined) return true;
  if (condition === objType) return true;
  if (condition === 'Node') return true;
  if (condition === 'Actor' || condition === 'RepositoryOwner') return objType === 'User';
  if (condition === 'GitObject') return objType === 'Commit' || objType === 'Tree' || objType === 'Blob';
  return false;
}

function isGqlObj(value: unknown): value is GqlObj {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as GqlObj).__type === 'string';
}

function executeInto(
  ctx: Ctx,
  obj: GqlObj,
  selections: SelectionNode[],
  defaults: Map<string, Value>,
  out: Record<string, unknown>,
): void {
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && typeMatches(obj.__type, fragment.typeCondition)) {
        executeInto(ctx, obj, fragment.selectionSet, defaults, out);
      }
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (typeMatches(obj.__type, selection.typeCondition)) {
        executeInto(ctx, obj, selection.selectionSet, defaults, out);
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = obj.__type;
      continue;
    }
    let value: unknown;
    try {
      value = resolveField(ctx, obj, selection.name, argsOf(ctx, selection, defaults));
    } catch (error) {
      if (error instanceof GqlFailure) {
        ctx.errors.push({ message: error.message });
        out[key] = null;
        continue;
      }
      throw error;
    }
    if (value === undefined) {
      ctx.errors.push({
        message: `Field '${selection.name}' doesn't exist on type '${obj.__type}'`,
      });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, value, selection, defaults);
  }
}

function completeValue(
  ctx: Ctx,
  value: unknown,
  selection: FieldNode,
  defaults: Map<string, Value>,
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item) => completeValue(ctx, item, selection, defaults));
  }
  if (isGqlObj(value)) {
    if (selection.selectionSet === undefined) return null;
    const out: Record<string, unknown> = {};
    executeInto(ctx, value, selection.selectionSet, defaults, out);
    return out;
  }
  if ((value as TypeRefObj).__gqlTypeRef === true) {
    // Introspection type references are plain objects handled via __Type rows.
    return value;
  }
  return value;
}

export interface GraphqlReply {
  status: number;
  body: unknown;
}

function executeOperation(
  forge: Forge,
  operation: OperationNode,
  fragments: Map<string, FragmentNode>,
  variables: Record<string, unknown>,
): { data: Record<string, unknown>; errors: { message: string }[] } {
  const ctx: Ctx = {
    forge,
    variables: new Map(Object.entries(variables)),
    fragments,
    errors: [],
  };
  const root: GqlObj = { __type: operation.operation === 'mutation' ? 'Mutation' : 'Query' };
  const data: Record<string, unknown> = {};
  executeInto(ctx, root, operation.selectionSet, operation.variableDefaults, data);
  return { data, errors: ctx.errors };
}

/** Handle one POST /api/graphql body (single operation or a batch array). */
export function handleGraphql(forge: Forge, rawBody: string): GraphqlReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { errors: [{ message: 'Request body is not valid JSON' }] } };
  }
  const runOne = (entry: unknown): unknown => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { errors: [{ message: 'Invalid GraphQL request' }] };
    }
    const request = entry as { query?: unknown; variables?: unknown; operationName?: unknown };
    if (typeof request.query !== 'string') {
      return { errors: [{ message: 'A query string is required' }] };
    }
    let document: DocumentNode;
    try {
      document = new Parser(lex(request.query)).parseDocument();
    } catch (error) {
      return { errors: [{ message: error instanceof Error ? error.message : 'Syntax error' }] };
    }
    if (document.operations.length === 0) {
      return { errors: [{ message: 'No operation found' }] };
    }
    const operationName = typeof request.operationName === 'string' ? request.operationName : undefined;
    const operation = operationName === undefined
      ? document.operations[0] as OperationNode
      : document.operations.find((candidate) => candidate.name === operationName) ?? (document.operations[0] as OperationNode);
    const variables = request.variables !== null && typeof request.variables === 'object' && !Array.isArray(request.variables)
      ? (request.variables as Record<string, unknown>)
      : {};
    const { data, errors } = executeOperation(forge, operation, document.fragments, variables);
    const body: Record<string, unknown> = { data };
    if (errors.length > 0) body.errors = errors;
    return body;
  };
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map(runOne) };
  }
  return { status: 200, body: runOne(parsed) };
}

export { ZERO_OID };
