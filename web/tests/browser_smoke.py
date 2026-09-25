"""Chromium DOM integration tests with File System Access test doubles.

Install: python -m pip install playwright && python -m playwright install chromium
Run: python web/tests/browser_smoke.py
Optional: CHROMIUM_PATH=/path/to/chromium python web/tests/browser_smoke.py

These are NOT native picker/OS permission tests. To run without any HTTP requests,
we inline the production modules/styles with SHA-256 CSP hashes in a test document.
Module imports are independently syntax-checked and unit-tested by Node.
"""
from __future__ import annotations

import base64
import hashlib
import os
from pathlib import Path
import re
import tempfile
import unittest
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
START = '\ufeff# Welcome\r\n\r\nA research notebook with [[Research/Alpha|Alpha]].\r\n\r\n## Work\r\n\r\n- [ ] Read paper\r\n\r\n## Sources\r\n\r\n[[Research/Beta]]\r\n\r\n#research\r\n'


def test_document(readonly: bool = False) -> str:
    import json
    html = (ROOT / 'index.html').read_text()
    modules = []
    for name in ['core.mjs', 'vault.mjs', 'tests/fake-fs.mjs']:
        source = (ROOT / name).read_text()
        source = re.sub(r'^import .*?;\n', '', source, flags=re.M)
        modules.append(re.sub(r'^export ', '', source, flags=re.M))
    modules.append(f'''globalThis.testVault = new MemoryDirectory('Test vault');
      testVault.add('Start.md', {json.dumps(START)});
      testVault.add('Research/Alpha.md', '---\\ntags: [systems]\\n---\\n# Alpha\\n\\n[[../Start]] and [[Beta]].');
      testVault.add('Research/Beta.md', '# Beta\\n\\nA needle in a notebook. #research');
      testVault.add('.git/private.md', 'Never indexed');
      Object.defineProperty(window, 'showDirectoryPicker', {{ configurable: true, value: {'undefined' if readonly else 'async () => testVault'} }});
    ''')
    modules.append(re.sub(r'^import .*?;\n', '', (ROOT / 'app.mjs').read_text(), flags=re.M))
    script = '\n'.join(modules)
    css = (ROOT / 'styles.css').read_text()
    digest = lambda value: base64.b64encode(hashlib.sha256(value.encode()).digest()).decode()
    policy = f"default-src 'none'; script-src 'sha256-{digest(script)}'; style-src 'sha256-{digest(css)}'; img-src blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    html = re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]+>', f'<meta http-equiv="Content-Security-Policy" content="{policy}">', html)
    html = re.sub(r'<link rel="icon"[^>]+>', '', html)
    html = html.replace('<link rel="stylesheet" href="styles.css">', f'<style>{css}</style>')
    html = html.replace('<script type="module" src="app.mjs"></script>', '')
    return html.replace('</body>', f'<script type="module">{script}</script></body>')


class BrowserSmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        options = {'headless': True}
        if os.environ.get('CHROMIUM_PATH'):
            options['executable_path'] = os.environ['CHROMIUM_PATH']
        cls.browser = cls.playwright.chromium.launch(**options)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.context = self.browser.new_context(viewport={'width': 1440, 'height': 950}, accept_downloads=True)
        self.page = self.context.new_page()
        self.page.set_default_timeout(3500)
        self.errors, self.requests = [], []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.on('console', lambda message: self.errors.append(message.text) if message.type == 'error' else None)
        self.page.on('request', lambda request: self.requests.append(request.url))
        self.page.set_content(test_document(readonly=self._testMethodName == 'test_07_readonly_folder_import_and_export'))

    def tearDown(self):
        self.assertEqual(self.errors, [], 'Browser runtime/CSP errors')
        self.assertEqual(self.requests, [], 'The test document must make no HTTP requests')
        self.context.close()

    def open_vault(self):
        self.page.locator('#welcome-open').click()
        expect(self.page.locator('#note-count')).to_have_text('3')
        self.page.locator('#file-tree [data-note="Start.md"]').click()
        expect(self.page.locator('#preview h1')).to_have_text('Welcome')

    def edit(self, text):
        self.page.get_by_role('button', name='Edit', exact=True).click()
        self.page.locator('#editor').fill(text)

    def test_01_welcome_search_and_tags(self):
        expect(self.page.locator('#welcome')).to_be_visible()
        expect(self.page.locator('#note-count')).to_have_text('0')
        self.open_vault()
        self.page.locator('#search').fill('needle')
        expect(self.page.locator('#file-tree [data-note]')).to_have_count(1)
        expect(self.page.locator('#file-tree [data-note]')).to_have_attribute('data-note', 'Research/Beta.md')
        self.page.locator('#all-notes').click()
        self.page.locator('[data-tag="systems"]').click()
        expect(self.page.locator('#file-tree [data-note]')).to_have_count(1)
        expect(self.page.locator('#file-tree [data-note]')).to_have_attribute('data-note', 'Research/Alpha.md')
        self.page.locator('#clear-tag').click()
        expect(self.page.locator('#file-tree [data-note]')).to_have_count(3)

    def test_02_draft_survives_navigation_then_saves(self):
        self.open_vault()
        self.edit('# My draft\n\nStill here.')
        self.page.locator('#file-tree [data-note="Research/Alpha.md"]').click()
        self.page.locator('#file-tree [data-note="Start.md"]').click()
        expect(self.page.locator('#editor')).to_have_value('# My draft\n\nStill here.')
        self.assertEqual(self.page.evaluate("testVault.lookup('Start.md').content"), START)
        self.page.locator('#save-note').click()
        expect(self.page.locator('#save-status')).to_have_text('Saved')
        self.assertEqual(self.page.evaluate("testVault.lookup('Start.md').content"), '# My draft\r\n\r\nStill here.')

    def test_03_checkbox_updates_only_the_source_marker(self):
        self.open_vault()
        self.page.locator('#preview input[type=checkbox]').check()
        self.page.locator('#save-note').click()
        expect(self.page.locator('#save-status')).to_have_text('Saved')
        self.assertEqual(self.page.evaluate("testVault.lookup('Start.md').content"), START.replace('- [ ]', '- [x]'))

    def test_04_conflict_keeps_draft_and_download_then_reload(self):
        self.open_vault()
        self.edit('# Browser draft')
        self.page.evaluate("testVault.lookup('Start.md').content = '# Terminal edit'")
        self.page.locator('#save-note').click()
        expect(self.page.locator('#document-alert')).to_contain_text('changed outside')
        expect(self.page.locator('#editor')).to_have_value('# Browser draft')
        self.assertEqual(self.page.evaluate("testVault.lookup('Start.md').content"), '# Terminal edit')
        self.page.locator('#refresh-vault').click()
        expect(self.page.locator('#editor')).to_have_value('# Browser draft')
        with self.page.expect_download() as result:
            self.page.locator('#download-note').click()
        download = result.value
        self.assertEqual(Path(download.path()).read_text(), '# Browser draft')
        self.page.locator('#reload-note').click()
        self.page.locator('#confirm-no').click()
        expect(self.page.locator('#editor')).to_have_value('# Browser draft')
        self.page.locator('#reload-note').click()
        self.page.locator('#confirm-yes').click()
        expect(self.page.locator('#editor')).to_have_value('# Terminal edit')
        expect(self.page.locator('#save-status')).to_have_text('Saved')

    def test_05_failed_save_is_visible_and_retryable(self):
        self.open_vault()
        self.edit('# Uncommitted')
        self.page.evaluate("testVault.lookup('Start.md').failWrite = true")
        self.page.locator('#save-note').click()
        expect(self.page.locator('#document-alert')).to_contain_text('write failure')
        self.assertEqual(self.page.evaluate("testVault.lookup('Start.md').content"), START)
        expect(self.page.locator('#save-note')).to_be_enabled()
        self.page.evaluate("testVault.lookup('Start.md').failWrite = false")
        self.page.locator('#save-note').click()
        expect(self.page.locator('#save-status')).to_have_text('Saved')

    def test_06_new_note_validation_and_explicit_creation(self):
        self.open_vault()
        self.page.locator('#new-note').click()
        expect(self.page.locator('#new-path')).to_be_focused()
        self.page.locator('#new-path').fill('../private')
        self.page.get_by_role('button', name='Create draft', exact=True).click()
        expect(self.page.locator('#new-error')).not_to_have_text('')
        self.page.locator('#new-path').fill('Research/New capture')
        self.page.get_by_role('button', name='Create draft', exact=True).click()
        expect(self.page.locator('#current-path')).to_have_text('Research/New capture.md')
        self.assertFalse(self.page.evaluate("!!testVault.lookup('Research/New capture.md')"))
        self.page.locator('#save-note').click()
        expect(self.page.locator('#save-status')).to_have_text('Saved')
        self.assertEqual(self.page.evaluate("testVault.lookup('Research/New capture.md').content"), '# New capture\n\n')

    def test_07_readonly_folder_import_and_export(self):
        expect(self.page.locator('#compatibility-note')).to_contain_text('read-only')
        with tempfile.TemporaryDirectory() as name:
            folder = Path(name)
            (folder / 'Read.md').write_text('# Imported\n\nA read-only snapshot.')
            self.page.locator('#folder-input').set_input_files(str(folder))
            expect(self.page.locator('#session-banner')).to_contain_text('READ-ONLY SNAPSHOT')
            self.edit('# A personal copy')
            expect(self.page.locator('#save-note')).to_be_disabled()
            with self.page.expect_download() as result:
                self.page.locator('#download-note').click()
            self.assertEqual(Path(result.value.path()).read_text(), '# A personal copy')
            self.assertEqual((folder / 'Read.md').read_text(), '# Imported\n\nA read-only snapshot.')
            expect(self.page.locator('#save-status')).to_have_text('Unsaved draft')

    def test_08_palette_keyboard_graph_and_modal_focus(self):
        self.open_vault()
        self.page.keyboard.press('Control+k')
        expect(self.page.locator('#command-input')).to_be_focused()
        self.page.locator('#command-input').fill('Alpha')
        self.page.keyboard.press('Enter')
        expect(self.page.locator('#current-path')).to_have_text('Research/Alpha.md')
        self.page.locator('#open-graph').click()
        expect(self.page.locator('#graph-canvas [data-note]')).to_have_count(3)
        before = self.page.locator('#graph-canvas').get_attribute('viewBox')
        self.page.locator('#zoom-in').click()
        self.assertNotEqual(before, self.page.locator('#graph-canvas').get_attribute('viewBox'))
        target = self.page.locator('#graph-canvas [data-note="Research/Beta.md"]')
        target.focus()
        self.page.keyboard.press('Enter')
        expect(self.page.locator('#current-path')).to_have_text('Research/Beta.md')
        self.page.locator('#new-note').click()
        self.page.keyboard.press('Escape')
        expect(self.page.locator('#new-dialog')).not_to_be_visible()
        expect(self.page.locator('#new-note')).to_be_focused()

    def test_09_demo_is_explicit_and_switch_guard_preserves_work(self):
        self.page.locator('#explore-demo').click()
        expect(self.page.locator('#session-banner')).to_contain_text('EXAMPLE VAULT')
        expect(self.page.locator('#save-note')).to_be_disabled()
        self.edit('# Volatile example draft')
        self.page.locator('#open-vault').click()
        expect(self.page.locator('#confirm-dialog')).to_be_visible()
        self.page.locator('#confirm-no').click()
        expect(self.page.locator('#editor')).to_have_value('# Volatile example draft')
        expect(self.page.locator('#vault-kind')).to_contain_text('Example')

    def test_10_untrusted_markdown_never_executes_or_fetches(self):
        content = '# Untrusted\n\n<img src=x onerror="globalThis.pwned=1">\n\n<script>globalThis.pwned=1</script>\n\n[bad](javascript:alert(1))\n\n![remote](https://invalid.example/tracker.png)\n\n[[Research/Alpha|<img onerror=alert(1)>]]'
        self.page.evaluate('(text) => testVault.add("Untrusted.md", text)', content)
        self.open_vault_with_count(4)
        self.page.locator('#file-tree [data-note="Untrusted.md"]').click()
        expect(self.page.locator('#preview img')).to_have_count(0)
        expect(self.page.locator('#preview script')).to_have_count(0)
        expect(self.page.locator('#preview a[href^="javascript:"]')).to_have_count(0)
        self.assertTrue(self.page.evaluate('globalThis.pwned === undefined'))
        expect(self.page.locator('#preview')).to_contain_text('<script>')

    def open_vault_with_count(self, count):
        self.page.locator('#welcome-open').click()
        expect(self.page.locator('#note-count')).to_have_text(str(count))

    def test_11_responsive_views_theme_and_navigation(self):
        self.open_vault()
        for width, height in [(390, 844), (320, 740), (768, 1024)]:
            self.page.set_viewport_size({'width': width, 'height': height})
            self.assertFalse(self.page.evaluate('document.documentElement.scrollWidth > innerWidth'), f'Overflow at {width}px')
            self.page.get_by_role('button', name='Split', exact=True).click()
            expect(self.page.locator('#editor')).to_be_visible()
            expect(self.page.locator('#preview')).to_be_visible()
            self.assertFalse(self.page.evaluate('document.documentElement.scrollWidth > innerWidth'))
        self.page.set_viewport_size({'width': 390, 'height': 844})
        self.page.locator('#toggle-sidebar').click()
        expect(self.page.locator('#sidebar')).to_be_visible()
        self.page.locator('#file-tree [data-note="Research/Alpha.md"]').click()
        expect(self.page.locator('#sidebar')).not_to_be_visible()
        self.page.locator('#theme').click()
        expect(self.page.locator('html')).to_have_attribute('data-theme', 'dark')

    def test_12_save_does_not_clobber_typing_during_write(self):
        self.open_vault()
        self.edit('# First snapshot')
        self.page.evaluate("testVault.lookup('Start.md').onWrite = () => new Promise(resolve => setTimeout(resolve, 500))")
        self.page.locator('#save-note').click()
        self.page.locator('#editor').fill('# Newer edits')
        self.page.wait_for_timeout(650)
        expect(self.page.locator('#editor')).to_have_value('# Newer edits')
        expect(self.page.locator('#save-status')).to_have_text('Unsaved draft')
        self.assertEqual(self.page.evaluate("testVault.lookup('Start.md').content"), '# First snapshot')


if __name__ == '__main__':
    unittest.main(verbosity=2)
