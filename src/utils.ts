import * as core from '@actions/core';
import { prerelease, rcompare, valid } from 'semver';
// @ts-ignore
import DEFAULT_RELEASE_TYPES from '@semantic-release/commit-analyzer/lib/default-release-types';
import { compareCommits, listTags } from './github';
import { defaultChangelogRules } from './defaults';
import { Await } from './ts';

type Tags = Await<ReturnType<typeof listTags>>;

export async function getValidTags(
  prefixRegex: RegExp,
  shouldFetchAllTags: boolean
) {
  const tags = await listTags(shouldFetchAllTags);

  const invalidTags = tags.filter(
    (tag) => !valid(tag.name.replace(prefixRegex, ''))
  );

  invalidTags.forEach((name) => core.debug(`Found Invalid Tag: ${name}.`));

  const validTags = tags
    .filter((tag) => valid(tag.name.replace(prefixRegex, '')))
    .sort((a, b) =>
      rcompare(a.name.replace(prefixRegex, ''), b.name.replace(prefixRegex, ''))
    );

  validTags.forEach((tag) => core.debug(`Found Valid Tag: ${tag.name}.`));

  return validTags;
}

export async function getCommits(baseRef: string, headRef: string) {
  const commits = await compareCommits(baseRef, headRef);

  return commits
    .filter((commit) => !!commit.commit.message)
    .map((commit) => ({
      message: commit.commit.message,
      hash: commit.sha,
    }));
}

export async function getScopedCommits(
  commits: Await<ReturnType<typeof getCommits>>,
  scopes: string[]
) {
  return commits.filter((commit) => {
    return scopes.some((scope) => {
      let re = new RegExp(
        '^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)\\(' +
          scope +
          '\\)\\: [\\w ]+',
        'g'
      );
      return commit.message.match(re);
    });
  });
}

export function getBranchFromRef(ref: string) {
  return ref.replace('refs/heads/', '');
}

export function isPr(ref: string) {
  return ref.includes('refs/pull/');
}

export function getLatestTag(
  tags: Tags,
  prefixRegex: RegExp,
  tagPrefix: string
) {
  return (
    tags.find((tag) => !prerelease(tag.name.replace(prefixRegex, ''))) || {
      name: `${tagPrefix}0.0.0`,
      commit: {
        sha: 'HEAD',
      },
    }
  );
}

export function getLatestPrereleaseTag(
  tags: Tags,
  identifier: string,
  prefixRegex: RegExp
) {
  return tags
    .filter((tag) => prerelease(tag.name.replace(prefixRegex, '')))
    .find((tag) => tag.name.replace(prefixRegex, '').match(identifier));
}

export function mapCustomReleaseRules(customReleaseTypes: string) {
  const releaseRuleSeparator = ',';
  const releaseTypeSeparator = ':';

  return customReleaseTypes
    .split(releaseRuleSeparator)
    .filter((customReleaseRule) => {
      const parts = customReleaseRule.split(releaseTypeSeparator);

      if (parts.length < 2) {
        core.warning(
          `${customReleaseRule} is not a valid custom release definition.`
        );
        return false;
      }

      const defaultRule = defaultChangelogRules[parts[0].toLowerCase()];
      if (customReleaseRule.length !== 3) {
        core.debug(
          `${customReleaseRule} doesn't mention the section for the changelog.`
        );
        core.debug(
          defaultRule
            ? `Default section (${defaultRule.section}) will be used instead.`
            : "The commits matching this rule won't be included in the changelog."
        );
      }

      if (!DEFAULT_RELEASE_TYPES.includes(parts[1])) {
        core.warning(`${parts[1]} is not a valid release type.`);
        return false;
      }

      return true;
    })
    .map((customReleaseRule) => {
      const [type, release, section] = customReleaseRule.split(
        releaseTypeSeparator
      );
      const defaultRule = defaultChangelogRules[type.toLowerCase()];

      // NOTE: 
      // Our desired behaviour is to trigger a "major" release if there is a breaking change
      // in any commit type. Due to the ordering in https://github.com/semantic-release/commit-analyzer/blob/master/index.js#L47
      // (analyzing custom rules first, and then if NONE match, analyzing the default rules) -
      // if we define a custom release rule, we also need to add a corresponding breaking/major rule
      // otherwise it will stop at the initial match even if it is a breaking commit
      //
      // E.g. 
      // - Custom release rule "build:patch" ({type: "build", release: "patch"})
      // - Commit message: "build(api): something\n\nBREAKING CHANGE: a breaking change"
      //
      // Will match "build" type, and output "patch" release BEFORE getting to the default {breaking: true, release: "major"} rule.
      //
      // With this change, a custom release rule of "build:patch" generates the following:
      // - [{type: "build", release: "major", breaking: true}, {type: "build", release: "patch"}]
      // And so will first match the breaking build commit rule, and generate a major release as desired
      return [
        {
          type,
          release: 'major',
          section: section || defaultRule?.section,
          breaking: true,
        },
        {
          type,
          release,
          section: section || defaultRule?.section,
          breaking: false,
        },
      ];
    })
    .flat();
}

export function mergeWithDefaultChangelogRules(
  mappedReleaseRules: ReturnType<typeof mapCustomReleaseRules> = []
) {
  const mergedRules = mappedReleaseRules.reduce(
    (acc, curr) => ({
      ...acc,
      [curr.type]: curr,
    }),
    { ...defaultChangelogRules }
  );

  return Object.values(mergedRules).filter((rule) => !!rule.section);
}
