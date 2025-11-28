import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import { type Loader }  from 'esbuild';

import { importMapEsbuildPlugin, ImportMapEsbuildPluginParams } from '../src/importmap-esbuild-plugin.js';

/** Save/restore global fetch between tests */
const realFetch = globalThis.fetch;
function setFetchMock(fn: typeof realFetch) {
  globalThis.fetch = fn;
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}
test.afterEach(() => {
  restoreFetch();
});

type RunBuildParams = {
  noTreeShaking?: boolean,
  cwd?: string,
  importMapEsbuildPluginParams?: ImportMapEsbuildPluginParams,
};

async function runBuild(entryPath: string, params?: RunBuildParams) {
  const result = await esbuild.build({
    entryPoints: [entryPath],
    write: false,
    bundle: true,
    format: 'esm',
    logLevel: 'silent',
    treeShaking: params?.noTreeShaking != null ? !params?.noTreeShaking : undefined,
    absWorkingDir: params?.cwd,
    plugins: [
      importMapEsbuildPlugin({
        ...params?.importMapEsbuildPluginParams,
        onLog(message) { console.log(message); },
      }),
    ],
  });

  const outFile = result.outputFiles[0];
  assert.ok(outFile, 'expected a JS output file');
  return { outputText: outFile.text, result };
}

class TempDir {
  public readonly dir: string;
  constructor(pathSegment: string) {
    this.dir = mkdtempSync(join(tmpdir(), pathSegment));
  }
  cleanup() {
    rmSync(this.dir, { recursive: true, force: true });
  }
  async createFile(relPath: string, content: string) {
    const filePath = resolve(this.dir, relPath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf8');
  }
  async makeDirectory(relPath: string) {
    const dirPath = resolve(this.dir, relPath);
    await mkdir(dirPath, { recursive: true });
  }
  resolve(relPath: string) {
    return resolve(this.dir, relPath);
  }
}

async function withTempDir(fn: (tmpDir: TempDir) => Promise<void>) {
  const tmpDir = new TempDir('import-map-');
  try {
    await fn(tmpDir);
  } finally {
    tmpDir.cleanup();
  }
}

/** Helper to make a Response-like object easily */
function makeResponse(body: BodyInit | null, { status = 200, contentType = "application/javascript" } = {}) {
  return new Response(body, {
    status,
    headers: contentType ? { "content-type": contentType } : undefined,
  });
}

test("plugin with no importMap behaves like no mappings (bare specifier unresolved)", async () => {
  await withTempDir(async (tmpDir) => {
    await tmpDir.createFile(
      "./index.js",
      'import "pkg";\n'
    );

    await assert.rejects(
      () =>
        runBuild(
          tmpDir.resolve("./index.js"),
          // NOTE: no importMapEsbuildPluginParams at all
        ),
      (err: any) => {
        const msg = String(err);
        assert.match(msg, /Could not resolve "pkg"/);
        return true;
      }
    );
  });
});

test("empty importMap behaves like no mappings (bare specifier unresolved)", async () => {
  await withTempDir(async (tmpDir) => {
    await tmpDir.createFile(
      "./index.js",
      'import "pkg";\n'
    );

    await assert.rejects(
      () =>
        runBuild(
          tmpDir.resolve("./index.js"),
          {
            importMapEsbuildPluginParams: {
              importMap: {
                imports: {}, // explicitly empty
              },
              baseDir: tmpDir.dir,
            },
          },
        ),
      (err: any) => {
        const msg = String(err);
        assert.match(msg, /Could not resolve "pkg"/);
        return true;
      }
    );
  });
});

test("relative imports remain untouched when import map is omitted", async () => {
  await withTempDir(async (tmpDir) => {
    await tmpDir.createFile(
      "./foo.js",
      'export const which = "relative-ok";\n'
    );

    await tmpDir.createFile(
      "./index.js",
      'import { which } from "./foo.js"; console.log(which);\n'
    );

    const { outputText } = await runBuild(
      tmpDir.resolve("./index.js"),
      // no importMapEsbuildPluginParams here either
    );

    // If the plugin did something stupid to relative imports, this would fail
    assert.match(outputText, /relative-ok/);
  });
});

test("relative imports are not affected by import map", async () => {
  await withTempDir(async (tmpDir) => {
    await tmpDir.createFile(
      "./foo.js",
      'export const which = "relative-ok";\n'
    );

    await tmpDir.createFile(
      "./index.js",
      [
        'import { which } from "./foo.js";',
        'console.log(which);',
        "",
      ].join("\n"),
    );

    const { outputText } = await runBuild(
      tmpDir.resolve("./index.js"),
      {
        importMapEsbuildPluginParams: {
          importMap: {
            imports: {
              // Some random bare mapping that should NOT affect "./foo.js"
              pkg: "./override.js",
              "pkg/": "./pkg/",
            },
          },
          baseDir: tmpDir.dir,
        },
      },
    );

    // If the plugin ever mis-applies import-map logic to relative imports,
    // this will break.
    assert.match(outputText, /relative-ok/);
  });
});

test("relative imports from mapped local targets resolve normally", async () => {
  await withTempDir(async (tmpDir) => {
    await tmpDir.createFile("./src/foo/index.js",
      [
        'import { x } from "./abc.js";',
        'console.log(x);',
      ].join("\n"),
    );

    await tmpDir.createFile(
      "./src/foo/abc.js",
      'export const x = "ok-rel";\n'
    );

    await tmpDir.createFile(
      "./index.js",
      'import "foo";\n'
    );

    const { outputText } = await runBuild(tmpDir.resolve("./index.js"), {
      importMapEsbuildPluginParams: {
        importMap: {
          imports: {
            foo: "./src/foo/index.js",
          },
        },
        baseDir: tmpDir.dir,
      },
    });

    assert.match(outputText, /ok-rel/);
  });
});

test('exact import mapping replaces bare specifier', async () => {

  await withTempDir(async(tmpDir) => {

    await tmpDir.createFile(
      './override.js',
      'export const which = "exact";\n'
    );
    await tmpDir.createFile(
      './pkg/index.js',
      'export const which = "prefix";\n'
    );
    await tmpDir.createFile(
      './index.js',
      'import { which } from "pkg"; console.log(which);\n'
    );

    const { outputText } = await runBuild(
      tmpDir.resolve('./index.js'),
      {
        importMapEsbuildPluginParams: {
          importMap: {
            imports: {
              pkg: './override.js',
              "pkg/": "./pkg/",
            },
          },
          baseDir: tmpDir.dir,
        },
      },
    );

    // Must use the exact-mapped module
    assert.match(outputText, /exact/);

    // Must not accidentally pull in the prefix-mapped one for "pkg"
    assert.doesNotMatch(outputText, /prefix/);

  });

});

test("scoped exact import mapping replaces bare specifier and beats scoped prefix", async () => {
  await withTempDir(async (tmpDir) => {
    await tmpDir.createFile(
      "./override.js",
      'export const which = "scoped-exact";\n'
    );

    await tmpDir.createFile(
      "./pkg/index.js",
      'export const which = "scoped-prefix";\n'
    );

    await tmpDir.createFile(
      "./index.js",
      'import { which } from "@scope/pkg"; console.log(which);\n'
    );

    const { outputText } = await runBuild(
      tmpDir.resolve("./index.js"),
      {
        importMapEsbuildPluginParams: {
          importMap: {
            imports: {
              "@scope/pkg": "./override.js",   // exact
              "@scope/pkg/": "./pkg/",         // prefix
            },
          },
          baseDir: tmpDir.dir,
        },
      },
    );

    // Must use the exact-mapped module
    assert.match(outputText, /scoped-exact/);

    // Must NOT accidentally use the prefix-mapped module for "@scope/pkg"
    assert.doesNotMatch(outputText, /scoped-prefix/);
  });
});

test("exact-only mapping does not apply to subpaths", async () => {
  await withTempDir(async (tmpDir) => {
    await tmpDir.createFile(
      "./override.js",
      'export const which = "exact-only";\n'
    );

    await tmpDir.createFile(
      "./index.js",
      [
        'import { which as a } from "pkg";',
        'import { which as b } from "pkg/subpath.js";',
        'console.log(a, b);',
        "",
      ].join("\n"),
    );

    // First, prove the exact mapping works for "pkg"
    // Then, prove "pkg/subpath.js" is NOT mapped and causes a normal esbuild error.

    // Exact import should succeed:
    // we assert via two-step: one build that only imports "pkg",
    // and one that shows "pkg/subpath.js" fails.

    // Build that only imports "pkg" (sanity)
    await tmpDir.createFile(
      "./index-exact.js",
      'import { which } from "pkg"; console.log(which);\n'
    );

    const { outputText: exactOutput } = await runBuild(
      tmpDir.resolve("./index-exact.js"),
      {
        importMapEsbuildPluginParams: {
          importMap: {
            imports: {
              pkg: "./override.js", // exact only, no "pkg/"
            },
          },
          baseDir: tmpDir.dir,
        },
      },
    );
    assert.match(exactOutput, /exact-only/);

    // Now the important part: "pkg/subpath.js" must NOT be mapped.
    await tmpDir.createFile(
      "./index-subpath.js",
      'import "pkg/subpath.js";\n'
    );

    await assert.rejects(
      () =>
        runBuild(
          tmpDir.resolve("./index-subpath.js"),
          {
            importMapEsbuildPluginParams: {
              importMap: {
                imports: {
                  pkg: "./override.js", // still only exact
                },
              },
              baseDir: tmpDir.dir,
            },
          },
        ),
      (err: any) => {
        const msg = String(err);
        assert.match(msg, /Could not resolve "pkg\/subpath\.js"/);
        return true;
      },
    );
  });
});

test('prefix mapping requires target value to end with "/"', async () => {
  await withTempDir(async (tmpDir) => {
    // Minimal entry file – it won't actually get to bundling because the plugin
    // should throw on invalid import map during plugin setup.
    await tmpDir.createFile('./index.js', 'console.log("ok");\n');

    await assert.rejects(
      () =>
        runBuild(tmpDir.resolve('./index.js'), {
          importMapEsbuildPluginParams: {
            importMap: {
              imports: {
                // ❌ invalid: key ends with "/", value does not
                'pkg/': './pkg',
              },
            },
            baseDir: tmpDir.dir,
          },
        }),
      /prefix key "pkg\/" must map to a value ending with "\/"/,
    );
  });
});

test('prefix mapping rewrites subpath imports', async () => {
  await withTempDir(async (tmpDir) => {
    await tmpDir.createFile(
      './pkg/index.js',
      'export const which = "pkg-root";\n'
    );
    await tmpDir.createFile(
      './pkg/util.js',
      'export const which = "pkg-util";\n'
    );
    await tmpDir.createFile(
      './index.js',
      'import { which as a } from "pkg/index.js"; import { which as b } from "pkg/util.js"; console.log(a, b);\n'
    );

    const { outputText } = await runBuild(
      tmpDir.resolve('./index.js'),
      {
        importMapEsbuildPluginParams: {
          importMap: {
            imports: {
              'pkg/': './pkg/',
            },
          },
          baseDir: tmpDir.dir,
        },
      },
    );

    assert.match(outputText, /pkg-root/);
    assert.match(outputText, /pkg-util/);
  });
});

test("prefix-only mapping does not satisfy plain specifier without trailing slash", async () => {
  await withTempDir(async (tmpDir) => {
    await tmpDir.createFile(
      "./pkg/index.js",
      'export const which = "prefix-root";\n'
    );

    // Import plain "pkg" – this should NOT be satisfied by "pkg/"
    await tmpDir.createFile(
      "./index.js",
      'import { which } from "pkg"; console.log(which);\n'
    );

    await assert.rejects(
      () =>
        runBuild(
          tmpDir.resolve("./index.js"),
          {
            importMapEsbuildPluginParams: {
              importMap: {
                imports: {
                  "pkg/": "./pkg/", // prefix only, no "pkg"
                },
              },
              baseDir: tmpDir.dir,
            },
          },
        ),
      (err: any) => {
        const msg = String(err);
        assert.match(msg, /Could not resolve "pkg"/);
        return true;
      },
    );
  });
});

test("scoped prefix mapping rewrites subpath imports", async () => {
  await withTempDir(async (tmpDir) => {
    await tmpDir.createFile(
      "./pkg/index.js",
      'export const which = "scoped-root";\n'
    );

    await tmpDir.createFile(
      "./pkg/util.js",
      'export const which = "scoped-util";\n'
    );

    await tmpDir.createFile(
      "./index.js",
      'import { which } from "@scope/pkg/util.js"; console.log(which);\n'
    );

    const { outputText } = await runBuild(
      tmpDir.resolve("./index.js"),
      {
        importMapEsbuildPluginParams: {
          importMap: {
            imports: {
              "@scope/pkg/": "./pkg/",
            },
          },
          baseDir: tmpDir.dir,
        },
      },
    );

    // Must use the prefix-mapped util module
    assert.match(outputText, /scoped-util/);

    // And not accidentally hit some other file
    assert.doesNotMatch(outputText, /scoped-root/);
  });
});

test("http import-map entry throws when enableHttp is not set", async () => {
  await withTempDir(async (tmpDir) => {
    await tmpDir.createFile(
      "./index.js",
      'import { a } from "example"; console.log(a);\n'
    );

    await assert.rejects(
      () =>
        runBuild(
          tmpDir.resolve("./index.js"),
          {
            importMapEsbuildPluginParams: {
              importMap: {
                imports: {
                  example: "https://example.com/a.js",
                },
              },
              baseDir: tmpDir.dir,
              // enableHttp: omitted on purpose
            },
          },
        ),
      (err: any) => {
        const msg = String(err);
        assert.match(msg, /HTTP\(S\) imports are disabled/i);
        return true;
      },
    );
  });
});

test("http import-map entry works when enableHttp is true", async () => {
  let calls = 0;
  setFetchMock(async (info) => {
    calls++;
    assert.equal(String(info), "https://example.com/a.js");
    return makeResponse("export const a = 1;");
  });

  await withTempDir(async (tmpDir) => {
    await tmpDir.createFile(
      "./index.js",
      'import { a } from "example"; console.log(a);\n'
    );

    const { outputText } = await runBuild(
      tmpDir.resolve("./index.js"),
      {
        importMapEsbuildPluginParams: {
          importMap: {
            imports: {
              example: "https://example.com/a.js",
            },
          },
          baseDir: tmpDir.dir,
          enableHttp: true,
        },
      },
    );

    assert.strictEqual(calls, 1);
    assert.ok(outputText.length > 0);
    assert.match(outputText, /1/);
  });
});

test('non-mapped bare specifiers fall back to esbuild resolver', async () => {
  await withTempDir(async (tmpDir) => {
    await tmpDir.createFile(
      './index.js',
      'import "some-bare-module";\n'
    );

    await assert.rejects(
      () => runBuild(
        tmpDir.resolve('./index.js'),
        {
          importMapEsbuildPluginParams: {
            importMap: {
              imports: {
                pkg: './override.js',
              },
            },
            baseDir: tmpDir.dir,
          },
        },
      ),
      (err: any) => {
        // Error is thrown by esbuild, not your plugin
        const msg = String(err);
        assert.match(
          msg,
          /Could not resolve "some-bare-module"/
        );
        return true;
      }
    );
  });
});

test("resolves bare specifier to https URL and fetches it once", async () => {
  let mockFetchCalledCount = 0;
  setFetchMock(async (info) => {
    mockFetchCalledCount++;
    const url = String(info);
    assert.equal(url, "https://example.com/a.js");
    return makeResponse("export const a = 1;");
  });
  await withTempDir(async (tmpDir) => {
    await tmpDir.createFile(
      './index.js',
      'import { a } from "example";\n'
    );

    await runBuild(
      tmpDir.resolve('./index.js'),
      {
        importMapEsbuildPluginParams: {
          importMap: {
            imports: {
              'example': 'https://example.com/a.js',
            },
          },
          baseDir: tmpDir.dir,
          enableHttp: true,
        },
      },
    );

    assert.strictEqual(mockFetchCalledCount, 1);
  });

});

test("scoped bare specifier resolves to https URL and fetches it once", async () => {
  let mockFetchCalledCount = 0;

  setFetchMock(async (info) => {
    mockFetchCalledCount++;
    const url = String(info);
    assert.equal(url, "https://example.com/scoped.js");
    return makeResponse("export const a = 1;");
  });

  await withTempDir(async (tmpDir) => {
    await tmpDir.createFile(
      "./index.js",
      'import { a } from "@scope/pkg"; console.log(a);\n'
    );

    const { outputText } = await runBuild(
      tmpDir.resolve("./index.js"),
      {
        importMapEsbuildPluginParams: {
          importMap: {
            imports: {
              "@scope/pkg": "https://example.com/scoped.js",
            },
          },
          baseDir: tmpDir.dir,
          enableHttp: true,
        },
      },
    );

    // One HTTP fetch for the scoped package mapping
    assert.strictEqual(mockFetchCalledCount, 1);

    // Sanity check: build produced *something*
    assert.ok(outputText.length > 0);
  });
});

test("https URL contents get bundled when used", async () => {
  setFetchMock(async (info) => {
    const url = String(info);
    assert.equal(url, "https://example.com/a.js");
    return makeResponse("export const a = 1;");
  });

  await withTempDir(async (tmpDir) => {
    await tmpDir.createFile(
      './index.js',
      'import { a } from "example"; console.log(a);\n'
    );

    const { outputText } = await runBuild(
      tmpDir.resolve('./index.js'),
      {
        importMapEsbuildPluginParams: {
          importMap: {
            imports: {
              example: 'https://example.com/a.js',
            },
          },
          baseDir: tmpDir.dir,
          enableHttp: true,
        },
      }
    );

    assert.match(outputText, /a\s*=\s*1/);
  });
});

test("leaves unknown bare imports inside http modules untouched", async () => {
  const calls: string[] = [];

  setFetchMock(async (info) => {
    const url = String(info);
    calls.push(url);

    if (url === "https://example.com/a.js") {
      // This module has a *bare* import, which should NOT be rewritten
      return makeResponse(`
import React from "react";

export function useSomething() {
  return React;
}
`);
    }

    // If the plugin ever tries to treat the bare "react" import
    // as an HTTP URL (e.g. https://example.com/react), we'll hit this:
    throw new Error("unexpected url " + url);
  });

  await withTempDir(async (tmpDir) => {

    await tmpDir.createFile(
      './index.js',
      `\
import { useSomething } from "example";
console.log(useSomething);
`);

    await assert.rejects(
      async () => {
        await runBuild(
          tmpDir.resolve('./index.js'),
          {
            importMapEsbuildPluginParams: {
              importMap: {
                imports: {
                  example: 'https://example.com/a.js',
                },
              },
              baseDir: tmpDir.dir,
              enableHttp: true,
            },
          }
        );
      },
      // We don't really care about the specific error here; esbuild
      // will complain it can't resolve "react", which is *expected*.
      () => true,
    );

    // The key assertion: only the top-level URL was ever fetched.
    assert.deepEqual(calls, [
      "https://example.com/a.js",
    ]);
  });

});

test("resolves relative imports inside http namespace", async () => {
  const calls: string[] = [];
  setFetchMock(async (info) => {
    const url = String(info);
    calls.push(url);

    if (url === "https://example.com/a.js") {
      return makeResponse(`
import { b } from "./b.js";
export const a = b + 1;
`);
    }
    if (url === "https://example.com/b.js") {
      return makeResponse(`export const b = 41;`);
    }
    throw new Error("unexpected url " + url);
  });

  await withTempDir(async (tmpDir) => {
    await tmpDir.createFile(
      './index.js',
      `\
import { a } from "example";
console.log(a);
`);

    const { outputText } = await runBuild(
      tmpDir.resolve('./index.js'),
      {
        importMapEsbuildPluginParams: {
          importMap: {
            imports: {
              example: 'https://example.com/a.js',
            },
          },
          baseDir: tmpDir.dir,
          enableHttp: true,
        },
      }
    );

    assert.deepEqual(calls, [
      "https://example.com/a.js",
      "https://example.com/b.js",
    ]);
    assert.match(outputText, /b\s*=\s*41/);
  });
});

test("pathname extension loader wins over content-type", async () => {
  // .ts URL but content-type says js
  setFetchMock(async (info) => {
    const url = String(info);
    assert.equal(url, "https://example.com/mod.ts");
    return makeResponse(`export const x: number = 1;`, {
      status: 200,
      contentType: "application/javascript",
    });
  });

  await withTempDir(async (tmpDir) => {
    await tmpDir.createFile(
      './index.js',
      `\
import { x } from "example";
console.log(x);
`);
    const { outputText } = await runBuild(
      tmpDir.resolve('./index.js'),
      {
        importMapEsbuildPluginParams: {
          importMap: {
            imports: {
              example: 'https://example.com/mod.ts',
            },
          },
          baseDir: tmpDir.dir,
          enableHttp: true,
        },
      }
    );
    // If loader wasn't 'ts', esbuild would throw on ': number'
    assert.match(outputText, /x\s*=\s*1/);
  });
});

test("content-type loader used when no extension", async () => {
  setFetchMock(async (info) => {
    const url = String(info);
    assert.equal(url, "https://example.com/mod");
    return makeResponse(`export const x: number = 2;`, {
      status: 200,
      contentType: "application/typescript; charset=utf-8",
    });
  });

  await withTempDir(async (tmpDir) => {
    await tmpDir.createFile(
      './index.js',
      `\
import { x } from "example";
console.log(x);
`);

    const { outputText } = await runBuild(
      tmpDir.resolve('./index.js'),
      {
        importMapEsbuildPluginParams: {
          importMap: {
            imports: {
              example: 'https://example.com/mod',
            },
          },
          baseDir: tmpDir.dir,
          enableHttp: true,
        },
      }
    );

    // If loader wasn't 'ts', build would fail
    assert.match(outputText, /x\s*=\s*2/);
  });

});

test("falls back to js loader when no ext and unknown content-type", async () => {
  setFetchMock(async (info) => {
    const url = String(info);
    assert.equal(url, "https://example.com/mod");
    return makeResponse(`export const x = 3;`, {
      status: 200,
      contentType: "application/octet-stream",
    });
  });

  await withTempDir(async (tmpDir) => {
    await tmpDir.createFile(
      './index.js',
      `\
import { x } from "example";
console.log(x);
`);

    const { outputText } = await runBuild(
      tmpDir.resolve('./index.js'),
      {
        importMapEsbuildPluginParams: {
          importMap: {
            imports: {
              example: 'https://example.com/mod',
            },
          },
          baseDir: tmpDir.dir,
          enableHttp: true,
        },
      }
    );

    assert.match(outputText, /x\s*=\s*3/);
  });
});

test("multiple downloads of same resource don't cause multiple fetches", async () => {
  let calls = 0;
  setFetchMock(async () => {
    calls++;
    return makeResponse(`export const x = 1;`);
  });

  await withTempDir(async (tmpDir) => {
    await tmpDir.createFile(
      './index.js',
      `\
  import "example";
  import "example";
  `);
    await runBuild(
      tmpDir.resolve('./index.js'),
      {
        importMapEsbuildPluginParams: {
          importMap: {
            imports: {
              example: 'https://example.com/a.js',
            },
          },
          baseDir: tmpDir.dir,
          enableHttp: true,
        },
      }
    );
    assert.equal(calls, 1);
  });
});

test("downloads of different identifiers that resolve to the resource don't cause multiple fetches", async () => {
  let calls = 0;
  setFetchMock(async () => {
    calls++;
    return makeResponse(`export const x = 1;`);
  });

  await withTempDir(async (tmpDir) => {
    await tmpDir.createFile(
      './index.js',
      `\
  import "example1";
  import "example2";
  `);
    await runBuild(
      tmpDir.resolve('./index.js'),
      {
        importMapEsbuildPluginParams: {
          importMap: {
            imports: {
              example1: 'https://example.com/a.js',
              example2: 'https://example.com/a.js',
            },
          },
          baseDir: tmpDir.dir,
          enableHttp: true,
        },
      }
    );
    assert.equal(calls, 1);
  });
});

test("throws on non-OK status", async () => {
  setFetchMock(async () => makeResponse("nope", { status: 404 }));

  await withTempDir(async (tmpDir) => {
    await tmpDir.createFile(
      './index.js',
      'import "example";'
    );

    await assert.rejects(
      async () => {
        await runBuild(
          tmpDir.resolve('./index.js'),
          {
            importMapEsbuildPluginParams: {
              importMap: {
                imports: {
                  example: 'https://example.com/a.js',
                },
              },
              baseDir: tmpDir.dir,
              enableHttp: true,
            },
          }
        );
      },
      (err) => {
        assert.match(String(err), /GET https:\/\/example\.com\/a\.js failed: status 404/);
        return true;
      }
    );
  });
});

test("aborts fetch on timeout", async () => {
  setFetchMock((_info, init) => {
    const signal = init?.signal;
    assert.ok(signal != null);
    return new Promise((_resolve, reject) => {
      // When abortController.abort() fires, the signal emits an event.
      signal.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
      // Never resolve → force timeout path
    });
  });

  await withTempDir(async (tmpDir) => {
    await tmpDir.createFile(
      './index.js',
      'import "example";');
    await assert.rejects(
      async () => {
        await runBuild(
          tmpDir.resolve('./index.js'),
          {
            importMapEsbuildPluginParams: {
              importMap: {
                imports: {
                  example: 'https://example.com/a.js',
                },
              },
              baseDir: tmpDir.dir,
              enableHttp: true,
              timeoutMs: 10,
            },
          }
        );
      },
      err => {
        // Test doesn't care about wording, just that it rejects.
        assert.match(String(err), /abort/i);
        return true;
      }
    );
  });
});

test("multiple different URLs are fetched separately", async () => {
  const calls = new Set();
  setFetchMock(async (info) => {
    const url = String(info);
    calls.add(url);
    if (url.endsWith("/a.js")) return makeResponse(`export const a = 1;`);
    if (url.endsWith("/b.js")) return makeResponse(`export const b = 2;`);
    throw new Error("unexpected " + url);
  });

  await withTempDir(async (tmpDir) => {
    await tmpDir.createFile(
      './index.js',
      `\
import "example-a";
import "example-b";
import "example-a";
import "example-b";
`);
    await runBuild(
      tmpDir.resolve('./index.js'),
      {
        importMapEsbuildPluginParams: {
          importMap: {
            imports: {
              'example-a': 'https://example.com/a.js',
              'example-b': 'https://example.com/b.js',
            },
          },
          baseDir: tmpDir.dir,
          enableHttp: true,
        },
      }
    );

    assert.deepEqual(calls, new Set([
      "https://example.com/a.js",
      "https://example.com/b.js",
    ]));
  });
});

test("dedupes transitive http imports (b.js loads once)", async () => {
  const callsByUrl = new Map();

  setFetchMock(async (info) => {
    const url = String(info);
    callsByUrl.set(url, (callsByUrl.get(url) ?? 0) + 1);

    if (url === "https://example.com/a.js") {
      return makeResponse(`\
import { b } from "./b.js";
export const a = b + 1;
`);
    }
    if (url === "https://example.com/b.js") {
      return makeResponse(`export const b = 41;`);
    }
    throw new Error("unexpected url " + url);
  });

  await withTempDir(async (tmpDir) => {
    await tmpDir.createFile(
      './index.js',
      `\
import { a } from "example/a.js";
import { b } from "example/b.js";
console.log(a, b);
`);

    const { outputText } = await runBuild(
      tmpDir.resolve('./index.js'),
      {
        importMapEsbuildPluginParams: {
          importMap: {
            imports: {
              'example/': 'https://example.com/',
            },
          },
          baseDir: tmpDir.dir,
          enableHttp: true,
        },
      }
    );

    // sanity
    assert.match(outputText, /b\s*\+\s*1/);
    assert.equal(callsByUrl.get("https://example.com/a.js"), 1);

    // key assertion
    assert.equal(callsByUrl.get("https://example.com/b.js"), 1);
  });
});

test("longest matching prefix wins when multiple prefixes match", async () => {
  await withTempDir(async (tmpDir) => {
    await tmpDir.createFile("./pkg/utils/index.js", 'export const which = "pkg-root";\n');
    await tmpDir.createFile("./pkg/utils1/index.js", 'export const which = "pkg-utils1";\n');
    await tmpDir.createFile("./index.js",
      'import { which } from "pkg/utils/index.js"; console.log(which);\n'
    );

    const { outputText } = await runBuild(
      tmpDir.resolve("./index.js"),
      {
        importMapEsbuildPluginParams: {
          importMap: {
            imports: {
              "pkg/": "./pkg/",
              "pkg/utils/": "./pkg/utils1/",
            },
          },
          baseDir: tmpDir.dir,
          enableHttp: true,
        },
      },
    );

    // must be utils, not root
    assert.match(outputText, /pkg-utils1/);
    assert.doesNotMatch(outputText, /pkg-root/);
  });
});

test("explicit baseDir is used instead of cwd", async () => {
  await withTempDir(async (tmpDir) => {
    // absDir/override.js -> should NOT be used
    await tmpDir.createFile(
      "./absDir/override.js",
      'export const which = "absDir";\n'
    );

    // baseDir/override.js -> this is the one we WANT used
    await tmpDir.createFile(
      "./baseDir/override.js",
      'export const which = "baseDir";\n'
    );

    // Entry imports "pkg"
    await tmpDir.createFile(
      "./index.js",
      'import { which } from "pkg"; console.log(which);\n'
    );

    const { outputText } = await runBuild(
      tmpDir.resolve("./index.js"),
      {
        importMapEsbuildPluginParams: {
          importMap: {
            imports: {
              pkg: "./override.js",
            },
          },
          // This should override absWorkingDir as the base
          baseDir: tmpDir.resolve("./baseDir"),
          enableHttp: true,
        },
        cwd: tmpDir.resolve("./absDir"),
      }
    );

    // Must use baseDir version
    assert.match(outputText, /baseDir/);

    // Must NOT accidentally pick up absDir version
    assert.doesNotMatch(outputText, /absDir/);
  });
});

test("falls back to cwd as baseDir when baseDir is omitted", async () => {
  await withTempDir(async (tmpDir) => {
    // Workdir with its own override.js
    await tmpDir.createFile(
      "./work/override.js",
      'export const which = "workDir";\n'
    );

    await tmpDir.createFile(
      "./work/index.js",
      'import { which } from "pkg"; console.log(which);\n'
    );

    const { outputText } = await runBuild(
      tmpDir.resolve("./work/index.js"),
      {
        importMapEsbuildPluginParams: {
          importMap: {
            imports: {
              pkg: "./override.js",
            },
          },
          // NOTE: no baseDir passed here on purpose
          enableHttp: true,
        },
        cwd: tmpDir.resolve("./work"),
      }
    );

    // If baseDir fell back to absWorkingDir, we should see workDir's value
    assert.match(outputText, /workDir/);
  });
});

test("loaderResolver overrides extension- and content-type-based loader", async () => {
  let mockFetchCalledCount = 0;

  setFetchMock(async (info) => {
    mockFetchCalledCount++;
    const url = String(info);
    assert.equal(url, "https://example.com/mod.js");

    // TS-only syntax; js loader would choke on this.
    return makeResponse('export const value: number = 42;\n');
  });

  await withTempDir(async (tmpDir) => {
    await tmpDir.createFile(
      "./index.js",
      'import { value } from "example"; console.log(value);\n'
    );

    const { outputText } = await runBuild(
      tmpDir.resolve("./index.js"),
      {
        importMapEsbuildPluginParams: {
          importMap: {
            imports: {
              example: "https://example.com/mod.js",
            },
          },
          baseDir: tmpDir.dir,
          enableHttp: true,
          // Key: force loader to 'ts' regardless of extension/content-type
          loaderResolver: async (_args, _res) => 'ts' as Loader,
        },
      },
    );

    // Ensure we actually hit the remote URL
    assert.strictEqual(mockFetchCalledCount, 1);

    // Build must succeed; type syntax should be stripped by TS loader.
    // We don't care about exact shape, just that something was emitted
    // and we didn't crash on TS syntax.
    assert.ok(outputText.length > 0);
    // Optional: sanity that 42 survived *somehow* in the bundle
    assert.match(outputText, /42/);
  });
});

test("loaderResolver returning null falls back to extension/content-type loader chain", async () => {
  let mockFetchCalledCount = 0;

  setFetchMock(async (info) => {
    mockFetchCalledCount++;
    const url = String(info);
    assert.equal(url, "https://example.com/mod.ts");

    // TS-only syntax; requires 'ts' loader if this is to succeed.
    return makeResponse('export const value: number = 99;\n', {
      // Even if content-type is JS, extension should win first.
      contentType: 'application/javascript',
    });
  });

  await withTempDir(async (tmpDir) => {
    await tmpDir.createFile(
      "./index.js",
      'import { value } from "example"; console.log(value);\n'
    );

    const { outputText } = await runBuild(
      tmpDir.resolve("./index.js"),
      {
        importMapEsbuildPluginParams: {
          importMap: {
            imports: {
              example: "https://example.com/mod.ts",
            },
          },
          baseDir: tmpDir.dir,
          enableHttp: true,
          // Explicitly *not* choosing a loader – should fall back
          loaderResolver: async (_args, _res) => null,
        },
      },
    );

    assert.strictEqual(mockFetchCalledCount, 1);
    assert.ok(outputText.length > 0);
    assert.match(outputText, /99/);
  });
});
