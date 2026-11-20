import {test} from 'node:test';
import assert from 'node:assert/strict';
import {visibleConversationText} from '../public/display-text.js';
test('hide metadata blocks but retain surrounding user content',()=>{
 assert.equal(visibleConversationText('<environment_context>\n<cwd>/private/path</cwd>\n</environment_context>\n请修复问题'),'请修复问题');
 assert.equal(visibleConversationText('前文\n<environment_context>secret</environment_context>\n正文\n<environment_context>other</environment_context>\n结尾'),'前文\n\n正文\n\n结尾');
 assert.equal(visibleConversationText('<environment_context>metadata</environment_context>'),'');
 assert.equal(visibleConversationText('正文\n<environment_context>incomplete'),'正文');
 assert.equal(visibleConversationText('解释 environment_context 的作用'),'解释 environment_context 的作用');
 assert.equal(visibleConversationText('<environment_context_example>example</environment_context_example>'),'<environment_context_example>example</environment_context_example>');
});
