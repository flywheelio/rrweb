import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as url from 'url';
import 'mocha';
import * as puppeteer from 'puppeteer';
import * as rollup from 'rollup';
import typescript = require('rollup-plugin-typescript');
import { assert } from 'chai';
import { SnapshotState, toMatchSnapshot } from 'jest-snapshot';
import { Suite } from 'mocha';

const htmlFolder = path.join(__dirname, 'html');
const htmls = fs.readdirSync(htmlFolder).map((filePath) => {
  const raw = fs.readFileSync(path.resolve(htmlFolder, filePath), 'utf-8');
  return {
    filePath,
    src: raw,
  };
});

interface IMimeType {
  [key: string]: string;
}

const server = () =>
  new Promise<http.Server>((resolve) => {
    const mimeType: IMimeType = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
    };
    const s = http.createServer((req, res) => {
      const parsedUrl = url.parse(req.url!);
      const sanitizePath = path
        .normalize(parsedUrl.pathname!)
        .replace(/^(\.\.[\/\\])+/, '');
      let pathname = path.join(__dirname, sanitizePath);
      try {
        const data = fs.readFileSync(pathname);
        const ext = path.parse(pathname).ext;
        res.setHeader('Content-type', mimeType[ext] || 'text/plain');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET');
        res.setHeader('Access-Control-Allow-Headers', 'Content-type');
        res.end(data);
      } catch (error) {
        res.end();
      }
    });
    s.listen(3030).on('listening', () => {
      resolve(s);
    });
  });

function matchSnapshot(actual: string, testFile: string, testTitle: string) {
  const snapshotState = new SnapshotState(testFile, {
    updateSnapshot: process.env.SNAPSHOT_UPDATE ? 'all' : 'new',
  });

  const matcher = toMatchSnapshot.bind({
    snapshotState,
    currentTestName: testTitle,
  });
  const result = matcher(actual);
  snapshotState.save();
  return result;
}

interface ISuite extends Suite {
  server: http.Server;
  browser: puppeteer.Browser;
  code: string;
}

describe('integration tests', function (this: ISuite) {
  this.timeout(10_000);

  before(async () => {
    this.server = await server();
    this.browser = await puppeteer.launch({
      // headless: false,
    });

    const bundle = await rollup.rollup({
      input: path.resolve(__dirname, '../src/index.ts'),
      plugins: [typescript()],
    });
    const { code } = await bundle.generate({
      name: 'rrweb',
      format: 'iife',
    });
    this.code = code;
  });

  after(async () => {
    await this.browser.close();
    await this.server.close();
  });

  for (const html of htmls) {
    if (html.filePath.substring(html.filePath.length - 1) === '~') {
      continue;
    }
    const title = '[html file]: ' + html.filePath;
    it(title, async () => {
      const page: puppeteer.Page = await this.browser.newPage();
      // console for debug
      // tslint:disable-next-line: no-console
      page.on('console', (msg) => console.log(msg.text()));
      if (html.filePath === 'iframe.html') {
        // loading directly is needed to ensure we don't trigger compatMode='BackCompat'
        // which happens before setContent can be called
        await page.goto(`http://localhost:3030/html/${html.filePath}`, {
          waitUntil: 'load',
        });
        const outerCompatMode = await page.evaluate('document.compatMode');
        const innerCompatMode = await page.evaluate('document.querySelector("iframe").contentDocument.compatMode');
        assert(outerCompatMode === 'CSS1Compat', outerCompatMode + ' for outer iframe.html should be CSS1Compat as it has "<!DOCTYPE html>"');
        // inner omits a doctype so gets rendered in backwards compat mode
        // although this was originally accidental, we'll add a synthetic doctype to the rebuild to recreate this
        assert(innerCompatMode === 'BackCompat', innerCompatMode + ' for iframe-inner.html should be BackCompat as it lacks "<!DOCTYPE html>"');
      } else {
        // loading indirectly is improtant for relative path testing
        await page.goto(`http://localhost:3030/html`);
        await page.setContent(html.src, {
          waitUntil: 'load',
        });
      }
      const rebuildHtml = (
        await page.evaluate(`${this.code}
        const x = new XMLSerializer();
        const [snap] = rrweb.snapshot(document);
        let out = x.serializeToString(rrweb.rebuild(snap, { doc: document })[0]);
        if (document.querySelector('html').getAttribute('xmlns') !== 'http://www.w3.org/1999/xhtml') {
          // this is just an artefact of serializeToString
          out = out.replace(' xmlns=\"http://www.w3.org/1999/xhtml\"', '');
        }
        out;  // return
      `)
      ).replace(/\n\n/g, '');
      const result = matchSnapshot(rebuildHtml, __filename, title);
      assert(result.pass, result.pass ? '' : result.report());
    }).timeout(5000);
  }

  it('correctly triggers backCompat mode and rendering', async () => {
    const page: puppeteer.Page = await this.browser.newPage();
    // console for debug
    // tslint:disable-next-line: no-console
    page.on('console', (msg) => console.log(msg.text()));

    await page.goto('http://localhost:3030/html/compat-mode.html', {
      waitUntil: 'load',
    });
    const compatMode = await page.evaluate('document.compatMode');
    assert(compatMode === 'BackCompat', compatMode + ' for compat-mode.html should be BackCompat as DOCTYPE is deliberately omitted');
    const renderedHeight = await page.evaluate('document.querySelector("center").clientHeight');
    // can remove following assertion if dimensions of page change
    assert(renderedHeight < 400, `pre-check: images will be rendered ~326px high in BackCompat mode, and ~588px in CSS1Compat mode; getting: ${renderedHeight}px`)
    const rebuildRenderedHeight = await page.evaluate(`${this.code}
const [snap] = rrweb.snapshot(document);
const iframe = document.createElement('iframe');
iframe.setAttribute('width', document.body.clientWidth)
iframe.setAttribute('height', document.body.clientHeight)
iframe.style.transform = 'scale(0.3)'; // mini-me
document.body.appendChild(iframe);
// magic here! rebuild in a new iframe
const rebuildNode = rrweb.rebuild(snap, { doc: iframe.contentDocument })[0];
iframe.contentDocument.querySelector('center').clientHeight
`);
    const rebuildCompatMode = await page.evaluate('document.querySelector("iframe").contentDocument.compatMode');
    assert(rebuildCompatMode === 'BackCompat', 'rebuilt compatMode should match source compatMode, but doesn\'t: ' + rebuildCompatMode);
    assert(rebuildRenderedHeight === renderedHeight, 'rebuilt height (${rebuildRenderedHeight}) should equal original height (${renderedHeight})')
    }).timeout(5000);

});

describe('iframe integration tests', function (this: ISuite) {

  before(async () => {
    this.server = await server();
    this.browser = await puppeteer.launch({
      // headless: false,
    });

    const bundle = await rollup.rollup({
      input: path.resolve(__dirname, '../src/index.ts'),
      plugins: [typescript()],
    });
    const { code } = await bundle.generate({
      name: 'rrweb',
      format: 'iife',
    });
    this.code = code;
  });

  after(async () => {
    await this.browser.close();
    await this.server.close();
  });

  it('snapshot async iframes', async () => {
    const page: puppeteer.Page = await this.browser.newPage();
    // console for debug
    // tslint:disable-next-line: no-console
    page.on('console', (msg) => console.log(msg.text()));
    await page.goto(`http://localhost:3030/iframe-html/main.html`, {
      waitUntil: 'load',
    });
    const snapshotResult = JSON.stringify(
      await page.evaluate(`${this.code};
      rrweb.snapshot(document)[0];
    `),
      null,
      2,
    );
    const result = matchSnapshot(snapshotResult, __filename, this.title);
    assert(result.pass, result.pass ? '' : result.report());
  }).timeout(5000);
});

describe('shadow DOM integration tests', function (this: ISuite) {

  before(async () => {
    this.server = await server();
    this.browser = await puppeteer.launch({
      // headless: false,
    });

    const bundle = await rollup.rollup({
      input: path.resolve(__dirname, '../src/index.ts'),
      plugins: [typescript()],
    });
    const { code } = await bundle.generate({
      name: 'rrweb',
      format: 'iife',
    });
    this.code = code;
  });

  after(async () => {
    await this.browser.close();
    await this.server.close();
  });

  it('snapshot shadow DOM', async () => {
    const page: puppeteer.Page = await this.browser.newPage();
    // console for debug
    // tslint:disable-next-line: no-console
    page.on('console', (msg) => console.log(msg.text()));
    await page.goto(`http://localhost:3030/html/shadow-dom.html`, {
      waitUntil: 'load',
    });
    const snapshotResult = JSON.stringify(
      await page.evaluate(`${this.code};
      rrweb.snapshot(document)[0];
    `),
      null,
      2,
    );
    const result = matchSnapshot(snapshotResult, __filename, this.title);
    assert(result.pass, result.pass ? '' : result.report());
  }).timeout(5000);
});
