/************************************************************************************************************

grunt
  - build the complete set of VexFlow libraries (with source-maps) for production and debug use.
grunt test
  - build the VexFlow libraries and run the QUnit command line tests with 'tests/flow-headless-browser.html'.
grunt reference
  - build the VexFlow libraries and run the copy:reference task, which copies the 
    current build/ to the reference/ folder, so that we can compare future builds to the reference/.
grunt release
  - run the release script to publish to npm and GitHub.

*************************************************************************************************************

grunt copy:reference
  - if you have recently run `grunt test` call this to save the current build/ to reference/.
grunt build:cjs
grunt build:esm
grunt build:types

grunt watch:fast
  - the fastest way to iterate while working on VexFlow.
grunt watch
grunt watch:prod
grunt watch:debug

grunt get:releases:versionX:versionY:...
grunt get:releases:3.0.9:4.0.0
  - retrieve previous releases for regression testing purposes.

Search this file for `grunt ` (the word grunt followed by a single space) to see what else is supported.

*************************************************************************************************************
Optional environment variables:

VEX_DEBUG_CIRCULAR_DEPENDENCIES
    if true, we display a list of circular dependencies in the code.
VEX_DEVTOOL
    specify webpack's devtool config (the default is 'source-map').
    https://webpack.js.org/configuration/devtool/
VEX_GENERATE_OPTIONS
    options for controlling the ./tools/generate_images.js script.
    see the 'generate:current' and 'generate:reference' tasks.

To pass in environment variables, you can use your ~/.bash_profile or do something like:
  export VEX_DEBUG_CIRCULAR_DEPENDENCIES=true
  export VEX_DEVTOOL=source-map
  grunt
You can also do it all on one line:
  VEX_DEBUG_CIRCULAR_DEPENDENCIES=true VEX_DEVTOOL=source-map grunt
*************************************************************************************************************/

console.log('GRUNTFILE START');

const path = require('path');
const fs = require('fs');
const { spawnSync, execSync } = require('child_process');
const { EventEmitter } = require('events');
const webpack = require('webpack');
const TerserPlugin = require('terser-webpack-plugin');

// A module entry file `entry/xxxx.ts` will be mapped to a build output file in build/cjs/ or /build/esm/entry/.
// Also see the package.json `exports` field, which is one way for projects to specify which entry file to import.
const VEX = 'vexflow';
const VEX_BRAVURA = 'vexflow-bravura';
const VEX_GONVILLE = 'vexflow-gonville';
const VEX_PETALUMA = 'vexflow-petaluma';
const VEX_CORE = 'vexflow-core'; // Supports dynamic import of the font modules below.
const VEX_FONT_BRAVURA = 'vexflow-font-bravura';
const VEX_FONT_GONVILLE = 'vexflow-font-gonville';
const VEX_FONT_PETALUMA = 'vexflow-font-petaluma';
const VEX_FONT_CUSTOM = 'vexflow-font-custom';
const VEX_DEBUG = 'vexflow-debug';
const VEX_DEBUG_TESTS = 'vexflow-debug-with-tests';

// Output directories.
const BASE_DIR = __dirname;
const BUILD_DIR = path.join(BASE_DIR, 'build');
const BUILD_CJS_DIR = path.join(BUILD_DIR, 'cjs');
const BUILD_ESM_DIR = path.join(BUILD_DIR, 'esm');
const BUILD_IMAGES_REFERENCE_DIR = path.join(BUILD_DIR, 'images', 'reference');
const REFERENCE_DIR = path.join(BASE_DIR, 'reference');
const REFERENCE_IMAGES_DIR = path.join(REFERENCE_DIR, 'images');

// PRODUCTION_MODE will enable minification, etc.
// See: https://webpack.js.org/configuration/mode/
const PRODUCTION_MODE = 'production';
// FOR DEBUGGING PURPOSES, you can temporarily comment out the line above and use the line below to disable minification.
// const PRODUCTION_MODE = 'development';
const DEVELOPMENT_MODE = 'development';

// Read environment variables to configure our scripts.
let DEBUG_CIRCULAR_DEPENDENCIES, DEVTOOL, GENERATE_IMAGES_ARGS;
function readEnvironmentVariables() {
  const env = process.env;
  let val = env.VEX_DEBUG_CIRCULAR_DEPENDENCIES;
  DEBUG_CIRCULAR_DEPENDENCIES = val === 'true' || val === '1';

  // Control the type of source maps that will be produced.
  // See: https://webpack.js.org/configuration/devtool/
  // In version 3.0.9 this environment variable was called VEX_GENMAP.
  DEVTOOL = env.VEX_DEVTOOL || 'source-map'; // for production builds with high quality source maps.

  val = env.VEX_GENERATE_OPTIONS;
  GENERATE_IMAGES_ARGS = val ? val.split(' ') : [];
}
readEnvironmentVariables();

function generateVersionFile() {
  // Generate version information when we run a build.
  // Save the information in src/version.ts.
  const VER = require('./tools/generate_version_file');
  return {
    BUILD_VERSION: VER.VERSION,
    BUILD_ID: VER.ID,
    BUILD_DATE: VER.DATE,
  };
}

function runCommand(command, ...args) {
  // The stdio option passes the output from the spawned process back to this process's console.
  spawnSync(command, args, { stdio: 'inherit' });
}

function webpackConfigs() {
  // entryFiles is one of the following:
  //   an array of file names
  //   an object that maps entry names to file names
  //   a file name string
  // returns a webpack config object.
  function getConfig(entryFiles, mode, addBanner, libraryName) {
    let entry, filename;
    if (Array.isArray(entryFiles)) {
      entry = {};
      for (const entryFileName of entryFiles) {
        // The entry point is a full path to a typescript file in vexflow/entry/.
        entry[entryFileName] = path.join(BASE_DIR, 'entry/', entryFileName + '.ts');
      }
      filename = '[name].js'; // output file names are based on the keys of the entry object above.
    } else if (typeof entryFiles === 'object') {
      entry = {};
      for (const k in entryFiles) {
        const entryFileName = entryFiles[k];
        entry[k] = path.join(BASE_DIR, 'entry/', entryFileName + '.ts');
      }
      filename = '[name].js'; // output file names are based on the keys of the entry object above.
    } else {
      // entryFiles is a string representing a single file name.
      const entryFileName = entryFiles;
      entry = path.join(BASE_DIR, 'entry/', entryFileName + '.ts');
      filename = entryFileName + '.js'; // output file name is the same as the entry file name, but with the js extension.
    }

    // Support different ways of loading VexFlow.
    // The `globalObject` string is assigned to `root` in line 15 of vexflow-debug.js.
    // VexFlow is exported as root["Vex"], and can be accessed via:
    //   - `window.Vex` in browsers
    //   - `globalThis.Vex` in node JS >= 12
    //   - `this.Vex` in all other environments
    // See: https://webpack.js.org/configuration/output/#outputglobalobject
    //
    // IMPORTANT: The outer parentheses are required! Webpack inserts this string into the final output, and
    // without the parentheses, code splitting will be broken. Search for `webpackChunkVex` inside the output files.
    let globalObject = `(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this)`;

    function getPlugins() {
      const plugins = [];

      // Add a banner at the top of the file.
      const { BUILD_VERSION, BUILD_ID, BUILD_DATE } = generateVersionFile();
      if (addBanner) {
        const banner =
          `VexFlow ${BUILD_VERSION}   ${BUILD_DATE}   ${BUILD_ID}\n` +
          `Copyright (c) 2010 Mohit Muthanna Cheppudira <mohit@muthanna.com>\n` +
          `https://www.vexflow.com   https://github.com/0xfe/vexflow`;
        plugins.push(new webpack.BannerPlugin(banner));
      }

      if (DEBUG_CIRCULAR_DEPENDENCIES) {
        const CircularDependencyPlugin = require('circular-dependency-plugin');
        plugins.push(new CircularDependencyPlugin({ cwd: process.cwd() }));
      }

      return plugins;
    }

    return {
      mode,
      entry,
      output: {
        path: BUILD_CJS_DIR,
        filename: filename,
        library: {
          name: libraryName,
          type: 'umd',
          export: 'default',
        },
        globalObject,
      },
      resolve: { extensions: ['.ts', '.tsx', '.js', '...'] },
      devtool: DEVTOOL,
      module: {
        rules: [
          {
            test: /(\.ts$|\.js$)/,
            exclude: /node_modules/,
            resolve: { fullySpecified: false },
            use: [
              {
                loader: 'ts-loader',
                options: { configFile: 'tsconfig.json' },
              },
            ],
          },
        ],
      },
      plugins: getPlugins(),
      optimization: {
        // DO NOT extract the banner into a separate file.
        minimizer: [new TerserPlugin({ extractComments: false })],
      },
    };
  }

  function prodConfig() {
    return getConfig([VEX, VEX_BRAVURA, VEX_GONVILLE, VEX_PETALUMA, VEX_CORE], PRODUCTION_MODE, BANNER, 'Vex');
  }

  function fontConfigs() {
    return [
      getConfig([VEX_FONT_BRAVURA], PRODUCTION_MODE, !BANNER, ['VexFlowFont', 'Bravura']),
      getConfig([VEX_FONT_PETALUMA], PRODUCTION_MODE, !BANNER, ['VexFlowFont', 'Petaluma']),
      getConfig([VEX_FONT_GONVILLE], PRODUCTION_MODE, !BANNER, ['VexFlowFont', 'Gonville']),
      getConfig([VEX_FONT_CUSTOM], PRODUCTION_MODE, !BANNER, ['VexFlowFont', 'Custom']),
    ];
  }

  function debugConfig() {
    // The DEVELOPMENT_MODE flag disables code minification.
    return getConfig([VEX_DEBUG, VEX_DEBUG_TESTS], DEVELOPMENT_MODE, BANNER, 'Vex');
  }

  function debugWatchConfig() {
    const config = debugConfig();
    config.watch = true;
    return config;
  }

  const BANNER = true;
  return {
    prodAndDebug: () => [prodConfig(), ...fontConfigs(), debugConfig()],
    prod: () => [prodConfig(), ...fontConfigs()],
    debug: () => debugConfig(),
    debugWatch: () => debugWatchConfig(),
  };
}

module.exports = (grunt) => {
  const log = grunt.log.writeln;

  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),
    webpack: webpackConfigs(),
    // grunt eslint
    eslint: {
      target: ['./src', './tests'],
      options: { fix: true, cache: true },
    },
    // grunt qunit
    // Runs unit tests on the command line by using flow-headless-browser.html.
    qunit: { files: ['tests/flow-headless-browser.html'] },
    open: {
      // grunt open:flow_html
      flow_html: { path: './tests/flow.html' },
      // grunt open:flow_localhost
      flow_localhost: { path: 'http://127.0.0.1:8080/tests/flow.html?esm=true' },
    },
    copy: {
      // grunt copy:reference
      reference: {
        files: [
          {
            expand: true,
            cwd: BUILD_DIR,
            src: ['**'],
            dest: REFERENCE_DIR,
          },
        ],
      },
      // grunt copy:save_reference_images
      // build/images/reference/ => reference/images/
      save_reference_images: {
        files: [
          {
            expand: true,
            cwd: BUILD_IMAGES_REFERENCE_DIR,
            src: ['**'],
            dest: REFERENCE_IMAGES_DIR,
          },
        ],
      },
      // grunt copy:restore_reference_images
      // reference/images/ => build/images/reference/
      restore_reference_images: {
        files: [
          {
            expand: true,
            cwd: REFERENCE_IMAGES_DIR,
            src: ['**'],
            dest: BUILD_IMAGES_REFERENCE_DIR,
          },
        ],
      },
    },
    // grunt typedoc
    typedoc: {
      build: {
        options: {
          out: 'docs/api',
          name: 'vexflow',
          excludeProtected: true,
          excludePrivate: true,
          disableSources: true,
        },
        src: ['./src/index.ts'],
      },
    },
    // grunt clean
    clean: {
      // grunt clean:build
      build: { src: [BUILD_DIR] },
      // grunt clean:reference
      reference: { src: [REFERENCE_DIR] },
      // grunt clean:reference_images
      reference_images: { src: [REFERENCE_IMAGES_DIR] },
    },
  });

  grunt.loadNpmTasks('grunt-contrib-clean');
  grunt.loadNpmTasks('grunt-contrib-copy');
  grunt.loadNpmTasks('grunt-contrib-qunit');
  grunt.loadNpmTasks('grunt-contrib-watch');
  grunt.loadNpmTasks('grunt-eslint');
  grunt.loadNpmTasks('grunt-open');
  grunt.loadNpmTasks('grunt-typedoc');
  grunt.loadNpmTasks('grunt-webpack');

  // grunt
  // Build all targets for production and debugging.
  grunt.registerTask('default', 'Build all VexFlow targets.', [
    'clean:build',
    'eslint',
    'webpack:prodAndDebug',
    'build:esm',
    'build:types',
    'typedoc',
  ]);

  // grunt test
  // Run command line qunit tests.
  grunt.registerTask('test', 'Run command line unit tests.', [
    'clean:build',
    'eslint',
    'webpack:prodAndDebug',
    'build:esm',
    'qunit',
  ]);

  // grunt build:cjs
  grunt.registerTask('build:cjs', 'Use webpack to create CJS files in build/cjs/', ['webpack:prodAndDebug']);

  // grunt build:esm
  // Output individual ES module files to build/esm/.
  // Also fixes the imports and exports so that they all end in .js.
  grunt.registerTask('build:esm', 'Use tsc to create ES module files in build/esm/', () => {
    generateVersionFile();
    log('ESM: Build to build/esm/');
    runCommand('tsc', '-p', 'tsconfig.esm.json');
    log('ESM: Fix Imports/Exports');
    runCommand('node', './tools/esm/fix-imports-and-exports.js', './build/esm/');
    // The build/esm/ folder needs a package.json that says "type": "module".
    log('ESM: Add package.json with "type": "module"');
    runCommand('cp', './tools/esm/package.json', './build/esm/package.json');
  });

  // grunt build:types
  // Output *.d.ts files to build/types/.
  grunt.registerTask('build:types', 'Use tsc to create *.d.ts files in build/types/', () => {
    log('Building *.d.ts files in build/types/');
    runCommand('tsc', '-p', 'tsconfig.types.json');
  });

  // grunt watch runs many tasks in parallel, so you might need to increase the limit (default: 10) to avoid warnings about memory leaks.
  // EventEmitter.defaultMaxListeners = 20;

  // grunt watch
  // Watch for changes and build all targets.
  grunt.config.set('watch', {
    scripts: {
      files: ['src/**', 'entry/**', 'tests/**', '!src/version.ts', '!**/node_modules/**', '!build/**'],
      options: {
        atBegin: false,
        interrupt: false,
        debounceDelay: 600,
      },
      tasks: ['clean:build', 'eslint', 'webpack:prodAndDebug', 'build:esm'],
    },
  });

  // During `grunt watch` configure eslint to only run on the changed file.
  grunt.event.on('watch', function (action, filePath) {
    grunt.config.set('eslint.target', [filePath]);
  });

  // grunt watch:prod
  // Watch for changes and build production CJS files.
  grunt.registerTask('watch:prod', '', () => {
    grunt.config.set('watch.scripts.tasks', ['clean:build', 'eslint', 'webpack:prod']);
    grunt.task.run('watch');
  });

  // grunt watch:debug
  // Watch for changes and build debug CJS files.
  grunt.registerTask('watch:debug', '', () => {
    grunt.config.set('watch.scripts.tasks', ['clean:build', 'eslint', 'webpack:debug']);
    grunt.task.run('watch');
  });

  // grunt watch:esm
  // Watch for changes and build esm/*.
  grunt.registerTask('watch:esm', '', () => {
    grunt.config.set('watch.scripts.tasks', ['clean:build', 'eslint', 'build:esm']);
    grunt.task.run('watch');
  });

  // grunt watch:fast
  // Watch for changes and only emit `build/cjs/vexflow-debug-with-tests.js`
  // Skips eslint!
  // This task is the fastest way to iterate while working on VexFlow.
  grunt.registerTask('watch:fast', '', () => {
    grunt.task.run(['clean:build', 'webpack:debugWatch']);
  });

  // grunt test:browser:cjs
  // Open the default browser to the flow.html test page.
  grunt.registerTask(
    'test:browser:cjs',
    'Test the CJS build by loading the flow.html file in the default browser.', //
    () => {
      // If the CJS build doesn't exist, build it.
      if (!fs.existsSync(BUILD_CJS_DIR)) {
        grunt.task.run('webpack:prodAndDebug'); // TODO: RONYEH Just debug?
        grunt.log.write('Build the CJS files.');
      } else {
        grunt.log.write('CJS files already exist. Skipping the build step.');
      }
      grunt.task.run('open:flow_html');
    }
  );

  // grunt test:browser:esm
  // Open the default browser to http://localhost:8080/tests/flow.html?esm=true
  // Requires a web server (e.g., `npx http-server`).
  grunt.registerTask(
    'test:browser:esm',
    'Test the ESM build in a web server by navigating to http://localhost:8080/tests/flow.html?esm=true',
    () => {
      // If the ESM build doesn't exist, build it.
      if (!fs.existsSync(BUILD_ESM_DIR)) {
        grunt.task.run('build:esm');
        log('Build the ESM files.');
      } else {
        log('ESM files already exist. Skipping the build step.');
      }
      grunt.task.run('open:flow_localhost');
      log('Remember to launch http-server in the vexflow/ directory!');
      log('npx http-server');
    }
  );

  // grunt reference
  // Build the current HEAD revision and copy it to reference/
  // After developing new features or fixing a bug, you can compare the current
  // working tree against the reference with: grunt test:reference
  grunt.registerTask('reference', 'Build to reference/.', [
    'clean',
    'webpack:prodAndDebug',
    'build:esm',
    'copy:reference',
  ]);

  // grunt generate:current
  // node ./tools/generate_images.js build ./build/images/current ${VEX_GENERATE_OPTIONS}
  grunt.registerTask('generate:current', 'Create images from the vexflow version in build/.', () => {
    runCommand('node', './tools/generate_images.js', 'build', './build/images/current', ...GENERATE_IMAGES_ARGS);
  });

  // grunt generate:reference
  // node ./tools/generate_images.js reference ./build/images/reference ${VEX_GENERATE_OPTIONS}
  grunt.registerTask('generate:reference', 'Create images from vexflow version in reference/.', () => {
    runCommand('node', './tools/generate_images.js', 'reference', './build/images/reference', ...GENERATE_IMAGES_ARGS);
  });

  // grunt generate:version
  grunt.registerTask('generate:version', '', () => {
    const info = generateVersionFile();
    console.log(info);
  });

  // grunt diff:reference
  grunt.registerTask('diff:reference', 'Compare ', () => {
    runCommand('./tools/visual_regression.sh');
  });

  // grunt test:reference
  grunt.registerTask('test:reference', 'Generate images from build/ and reference/ and compare them.', [
    'test',
    'generate:current',
    'generate:reference',
    'diff:reference',
  ]);

  // grunt test:reference:cache
  // Faster than `grunt test:reference` because it reuses the existing reference images if available.
  grunt.registerTask('test:reference:cache', '', [
    'cache:save:reference',
    'test',
    'generate:current',
    'cache:restore:reference',
    'diff:reference',
  ]);

  grunt.registerTask('cache:save:reference', '', () => {
    if (fs.existsSync(BUILD_IMAGES_REFERENCE_DIR)) {
      grunt.task.run('clean:reference_images');
      grunt.task.run('copy:save_reference_images');
    }
  });

  // If the reference images are not available, run the 'generate:reference' task.
  grunt.registerTask('cache:restore:reference', '', () => {
    if (fs.existsSync(REFERENCE_IMAGES_DIR)) {
      grunt.task.run('copy:restore_reference_images');
    } else {
      grunt.task.run('generate:reference');
    }
  });

  // grunt get:releases:3.0.9:4.0.0   =>   node ./tools/get_releases.mjs 3.0.9 4.0.0
  // Note: the arguments are separated by colons!
  grunt.registerTask('get:releases', '', () => {
    runCommand('node', './tools/get_releases.mjs', ...grunt.task.current.args);
  });

  // grunt release
  // Release to npm and GitHub.
  grunt.registerTask('release', '', () => {
    verifyGitWorkingDirectory();
    runCommand('npx', 'release-it');
  });

  // grunt release:alpha
  grunt.registerTask('release:alpha', '', () => {
    verifyGitWorkingDirectory();
    runCommand('npx', 'release-it', '--preRelease=alpha');
  });

  // grunt release:beta
  grunt.registerTask('release:beta', '', () => {
    verifyGitWorkingDirectory();
    runCommand('npx', 'release-it', '--preRelease=beta');
  });

  // grunt release:rc
  grunt.registerTask('release:rc', '', () => {
    verifyGitWorkingDirectory();
    runCommand('npx', 'release-it', '--preRelease=rc');
  });

  // grunt release:dry-run
  // Walk through the release process without actually doing anything.
  grunt.registerTask('release:dry-run', '', () => {
    verifyGitWorkingDirectory();
    runCommand('npx', 'release-it', '--dry-run');
  });

  // grunt release:dry-run:alpha
  grunt.registerTask('release:dry-run:alpha', '', () => {
    verifyGitWorkingDirectory();
    runCommand('npx', 'release-it', '--dry-run', '--preRelease=alpha');
  });

  // grunt release:dry-run:beta
  grunt.registerTask('release:dry-run:beta', '', () => {
    verifyGitWorkingDirectory();
    runCommand('npx', 'release-it', '--dry-run', '--preRelease=beta');
  });

  // grunt release:dry-run:rc
  grunt.registerTask('release:dry-run:rc', '', () => {
    verifyGitWorkingDirectory();
    runCommand('npx', 'release-it', '--dry-run', '--preRelease=rc');
  });

  // grunt build-test-release
  grunt.registerTask('build-test-release', '', () => {
    grunt.task.run('default');
    grunt.task.run('qunit');
    verifyGitWorkingDirectory();
    grunt.task.run('release:dry-run'); // TODO: remove dry-run!
  });

  // @return true if the git working directory is clean, other than the auto-generated `src/version.ts` file.
  function verifyGitWorkingDirectory() {
    const output = execSync('git status -s').toString();
    console.log('The Output Was');
    const lines = output.split('\n');
    let numDirtyFiles = 0;
    for (const ln in lines) {
      const line = lines[ln].trim();
      if (line === '') {
        continue;
      } else if (line.includes('src/version.ts')) {
        console.log('OK', line);
      } else {
        console.log('!!', line);
        numDirtyFiles++;
      }
    }

    if (numDirtyFiles > 0) {
      grunt.fail.fatal('Please commit or stash your changes before releasing to npm and GitHub.', 1);
      return false;
    } else {
      console.log('The git working directory is clean.');
      return true;
    }
  }

  // grunt.registerTask('xxx', '', function () {
  //   const done = this.async();
  //   grunt.util.spawn(
  //     {
  //       grunt: true,
  //       args: ['yyy'],
  //       opts: { stdio: 'inherit' },
  //     },
  //     (error, result) => {
  //       if (error) {
  //         grunt.log.error().error(result.stdout).writeln();
  //       } else {
  //         grunt.log.ok().verbose.ok(result.stdout);
  //         done(true);
  //       }
  //     }
  //   );
  //   grunt.util.spawn(
  //     {
  //       grunt: true,
  //       args: ['zzz'],
  //       opts: { stdio: 'inherit' },
  //     },
  //     (error, result) => {
  //       if (error) {
  //         grunt.log.error().error(result.stdout).writeln();
  //       } else {
  //         grunt.log.ok().verbose.ok(result.stdout);
  //         done(true);
  //       }
  //     }
  //   );
  // });

  // grunt.registerTask('yyy', '', function () {
  //   const done = this.async();
  //   const id = setInterval(() => {
  //     console.log('YYY ' + Math.random());
  //   }, 1000);
  //   setTimeout(() => {
  //     clearInterval(id);
  //     done(true);
  //   }, 5100);
  // });

  // grunt.registerTask('zzz', '', function () {
  //   const done = this.async();
  //   const id = setInterval(() => {
  //     console.log('ZZZ ' + Math.random());
  //   }, 1000);
  //   setTimeout(() => {
  //     clearInterval(id);
  //     done(true);
  //   }, 5100);
  // });
};
