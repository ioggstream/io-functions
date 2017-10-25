/**
 * This file contains gulp (https://gulpjs.com/) tasks to run at build time.
 * See also npm tasks in package.json.
 */

const fs = require('fs');

const argv = require("yargs").argv;
const path = require("path");
const runSequence = require('run-sequence');

const gulp = require("gulp");
const textSimple = require("gulp-text-simple");
const rename = require("gulp-rename");
const exec = require("gulp-exec");
const git = require("gulp-git");
const jsonEditor = require("gulp-json-editor");

const semver = require("semver");
const mjml = require("mjml");

const TYPESCRIPT_SOURCE_DIR = "lib";

const TEMPLATES_SOURCE_DIR = "templates/mjml";
const TEMPLATES_SOURCE = `${TEMPLATES_SOURCE_DIR}/*.mjml`;
const TEMPLATES_OUTPUT_DIR = `${TYPESCRIPT_SOURCE_DIR}/templates/html`;

const GIT_RELEASE_BRANCH = "master";
const GIT_ORIGIN = "origin";

// resolve the root directory of this project
const rootDir = path.resolve(argv.rootDir || './') + '/';

// path to the root `package.json`
const packageJsonPath = path.join(rootDir, "package.json");

// the content of the root `package.json`
const currentPackageJson = JSON.parse(fs.readFileSync(packageJsonPath));

// the following values are calculated for every task but are only used during
// the release process, not super efficient but it's the easiest way to share
// them across tasks
const currentVersion = semver.parse(currentPackageJson.version);
const releaseVersionValue = `${currentVersion.major}.${currentVersion.minor}.${currentVersion.patch}`;
const nextVersionValue = `${semver.inc(releaseVersionValue, "minor")}-SNAPSHOT`;
const funcpackBranchPrefix = "funcpack-release";
const releaseVersionFuncpackBranchName = `${funcpackBranchPrefix}-v${releaseVersionValue}`;

/**
 * Transform a mjml template to a Typescript function outputting HTML.
 *
 * @param content the content of mjml template as string
 * @param options options object (see gulp-text-simple plugin https://www.npmjs.com/package/gulp-text-simple)
 */
const toMjml = (content, options) => {
  const name = path.basename(options.sourcePath);
  return [
    `// DO NOT EDIT THIS FILE`,
    `// this file was auto generated from '${name}'`,
    `export default function(`,
    `  title: string,`,
    `  headlineText: string,`,
    `  senderOrganizationName: string,`,
    `  senderServiceName: string,`,
    `  titleText: string,`,
    `  contentHtml: string,`,
    `  footerHtml: string`,
    `): string {`,
    `  return \``,
    `${mjml.mjml2html(content, { minify: true }).html}\`;`,
    `}`,
    ""
  ].join("\n");
};

/**
 * Generate Typescript template files from mjml (https://mjml.io/).
 */
gulp.task("generate:templates", () => {
  return gulp
    .src(TEMPLATES_SOURCE)
    .pipe(textSimple(toMjml)())
    .pipe(rename((filepath) => (filepath.extname = ".ts")))
    .pipe(gulp.dest(TEMPLATES_OUTPUT_DIR));
});

/**
 * Run the build task
 */
gulp.task("yarn:build", () => {
  return gulp.src(TYPESCRIPT_SOURCE_DIR)
    .pipe(exec(`yarn build`))
    .pipe(exec.reporter());
});

/**
 * Run the test task
 */
gulp.task("yarn:test", () => {
  return gulp.src(TYPESCRIPT_SOURCE_DIR)
    .pipe(exec(`yarn test`))
    .pipe(exec.reporter());
});

/**
 * Package Azure Functions code and dependencines in a single file
 */
gulp.task("yarn:funcpack", () => {
  return gulp.src(TYPESCRIPT_SOURCE_DIR)
    .pipe(exec("yarn run funcpack pack ./"))
    .pipe(exec.reporter());
});

/**
 * Checks out the release branch
 */
gulp.task("git:checkout:release", (cb) => {
  return git.checkout(GIT_RELEASE_BRANCH, {}, cb);
});

/**
 * Fails if repository has untracked files
 */
gulp.task("git:check:untracked", (cb) => {
  return git.exec({
    args: "ls-files --other --exclude-standard"
  }, (err, stdout) => {
    if (err) {
      throw(err);
    };
    if (stdout.trim().length > 0) {
      return cb("Repository must not have untracked files");
    }
    cb();
  });
});

/**
 * Fails if repository has modified files
 */
gulp.task("git:check:modified", (cb) => {
  return git.exec({
    args: "ls-files --modified --exclude-standard"
  }, (err, stdout) => {
    if (err) {
      throw(err);
    };
    if (stdout.trim().length > 0) {
      return cb("Repository must not have modified files");
    }
    cb();
  });
});

/**
 * Fails if repository is not clean
 */
gulp.task("git:check:clean", ["git:check:untracked", "git:check:modified"]);

/**
 * Fails if current branch is not GIT_RELEASE_BRANCH
 */
gulp.task("git:check:branch", (cb) => {
  return git.exec({
    args: "symbolic-ref HEAD"
  }, (err, stdout) => {
    if (err) {
      throw(err);
    };
    if (stdout.trim() !== `refs/heads/${GIT_RELEASE_BRANCH}`) {
      return cb(`You must be on the ${GIT_RELEASE_BRANCH} branch`);
    }
    cb();
  });
});

/**
 * Push master to origin
 */
gulp.task("git:push:origin", (cb) => {
  return git.push(GIT_ORIGIN, GIT_RELEASE_BRANCH, {}, cb);
});

/**
 * Push the tags to origin
 */
gulp.task("git:push:tags", (cb) => {
  return git.push(GIT_ORIGIN, GIT_RELEASE_BRANCH, { args: "--tags" }, cb);
});

/**
 * Bump the version to the release version
 */
gulp.task("release:bump:release", () => {
  return gulp.src(packageJsonPath)
    .pipe(jsonEditor({
      "version": releaseVersionValue
    }))
    .pipe(gulp.dest(rootDir));
});

/**
 * Commit package.json with updated release version
 */
gulp.task("release:git:commit:release", () => {
  return gulp.src(packageJsonPath)
    .pipe(git.add())
    .pipe(git.commit(`Bumped release ${releaseVersionValue}`));
})

/**
 * Tag last commit with the release version
 */
gulp.task("release:git:tag:release", (cb) => {
  const tag = `v${releaseVersionValue}`;
  return git.tag(tag, `Created tag for version ${tag}`, cb);
})

/**
 * Creates a new branch for storing funcpack assets
 */
gulp.task("release:git:checkout:funcpack", (cb) => {
  return git.checkout(releaseVersionFuncpackBranchName, { args: "-b" }, cb);
});

/**
 * Adds funcpack assets
 */
gulp.task("release:git:commit:funcpack", (cb) => {
  return gulp.src(["*/function.json", ".funcpack/index.js"])
    .pipe(git.add({ args: "-f" })) // force because .gitignore contains *.js
    .pipe(git.commit(`Adds funcpack assets for release ${releaseVersionValue}`));
});

/**
 * Pushes funcpack branch to origin
 */
gulp.task("release:git:push:funcpack", (cb) => {
  return git.push(GIT_ORIGIN, releaseVersionFuncpackBranchName, { args: "-u" }, cb);
});

/**
 * Updates the remote "latest" funcpack branch to the current funcpack branch
 */
gulp.task("release:git:push:funcpack:latest", (cb) => {
  return git.push(GIT_ORIGIN, `${releaseVersionFuncpackBranchName}:${funcpackBranchPrefix}-latest`, { args: "-f" }, cb);
});

/**
 * Bump the version to the snapshot version
 */
gulp.task("release:bump:next", () => {
  return gulp.src(packageJsonPath)
    .pipe(jsonEditor({
      "version": nextVersionValue
    }))
    .pipe(gulp.dest(rootDir));
});

/**
 * Commit package.json with updated snapshot version
 */
gulp.task("release:git:commit:next", () => {
  return gulp.src(packageJsonPath)
    .pipe(git.add())
    .pipe(git.commit(`Bumped release ${nextVersionValue}`));
})

gulp.task("release", function (cb) {
  runSequence(
    // check that the release is running on the GIT_RELEASE_BRANCH branch
    "git:check:branch",
    // check that the working directory is a git repository and
    // the repository has no outstanding changes.
    "git:check:clean",
    // run tests
    "yarn:test",
    // bumps the version to the next release version:
    // current version without the qualifier (eg. 1.2-SNAPSHOT -> 1.2)
    "release:bump:release",
    // commit the changes in package.json
    "release:git:commit:release",
    // tag the previous commit with v$version (eg. v1.2, v1.2.3).
    "release:git:tag:release",
    // checkout a new branch funcpack-release-vx.x.x
    "release:git:checkout:funcpack",
    // build and run funcpack
    "yarn:build",
    "yarn:funcpack",
    // commits and pushes funcpack branch
    "release:git:commit:funcpack",
    "release:git:push:funcpack",
    "release:git:push:funcpack:latest",
    // check out the release branch (master)
    "git:checkout:release",
    // bumps the version to the next snapshot version:
    // increase the minor version segment of the current version and set the
    // qualifier to '-SNAPSHOT' (eg. 1.2.1-SNAPSHOT -> 1.3.0-SNAPSHOT)
    "release:bump:next",
    // commit the changes in package.json
    "release:git:commit:next",
    // push changes to origin
    "git:push:origin",
    "git:push:tags",
    (err) => {
      if (err) {
        console.log(err.message);
      } else {
        console.log('RELEASE FINISHED SUCCESSFULLY');
      }
      cb(err);
    });
});

gulp.task("default", ["generate:templates"]);