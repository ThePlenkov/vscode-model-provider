const vscode = require('vscode');
const assert = require('assert');

// Export the test suite for Mocha
module.exports = function(context) {
  const suite = context.suite;

  suite('Extension Test Suite', function() {
    vscode.window.showInformationMessage('Start all tests.');

    test('Extension should be present', function() {
      const ext = vscode.extensions.getExtension('theplenkov.vscode-model-provider');
      console.log('Extension found:', ext);
      assert.ok(ext, 'Extension should be present');
    });

    test('Extension should activate', async function() {
      const ext = vscode.extensions.getExtension('theplenkov.vscode-model-provider');
      assert.ok(ext, 'Extension should be present');
      await ext?.activate();
      assert.strictEqual(ext?.isActive, true, 'Extension should be active');
    });

    test('Model provider should be registered', async function() {
      const ext = vscode.extensions.getExtension('theplenkov.vscode-model-provider');
      assert.ok(ext, 'Extension should be present');
      await ext?.activate();
      
      // Wait a bit for provider registration
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Check if any models are available
      const models = await vscode.lm.selectChatModels();
      console.log('Available models count:', models.length);
      console.log('Available models:', models.map(m => ({ id: m.id, name: m.name })));
      assert.ok(models.length > 0, 'Should have at least one model available');
    });

    test('Models should have correct metadata', async function() {
      const ext = vscode.extensions.getExtension('theplenkov.vscode-model-provider');
      assert.ok(ext, 'Extension should be present');
      await ext?.activate();
      
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const models = await vscode.lm.selectChatModels();
      const claudeModels = models.filter(m => m.name.includes('Claude'));
      
      console.log('Claude models count:', claudeModels.length);
      console.log('Claude models:', claudeModels.map(m => ({
        id: m.id,
        name: m.name,
        maxInputTokens: m.maxInputTokens,
        maxOutputTokens: m.maxOutputTokens,
        inputCost: m.inputCost,
        outputCost: m.outputCost
      })));
      
      assert.ok(claudeModels.length > 0, 'Should have at least one Claude model');
      
      // Check that Claude Sonnet has the expected metadata
      const sonnet = claudeModels.find(m => m.name.includes('Sonnet'));
      if (sonnet) {
        assert.ok(sonnet.maxInputTokens > 0, 'Sonnet should have maxInputTokens');
        assert.ok(sonnet.maxOutputTokens > 0, 'Sonnet should have maxOutputTokens');
        console.log('Sonnet model metadata verified');
      }
    });
  });
};

