/**
 * TDD Tests for feature-generator module
 *
 * Tests feature list generation from task descriptions:
 * - Numbered list parsing (1., 1))
 * - Bullet point parsing (-, *)
 * - Keyword-based parsing (feature:, implement:, etc.)
 * - Fallback single feature creation
 * - Edge cases (empty strings, whitespace, long descriptions)
 */

import { describe, it, expect } from 'vitest';
import { generateFeatureList, DECOMPOSITION_PROMPT } from './feature-generator.js';

describe('feature-generator module', () => {
  describe('generateFeatureList', () => {
    describe('numbered list parsing', () => {
      it('should parse numbered list with periods (1.)', () => {
        const task = `
1. Create user model
2. Add authentication
3. Build API endpoints
        `;

        const features = generateFeatureList(task);

        expect(features).toHaveLength(3);
        expect(features[0]).toMatchObject({
          id: 'feature-1',
          description: 'Create user model',
          status: 'pending',
          attempts: 0,
        });
        expect(features[1]).toMatchObject({
          id: 'feature-2',
          description: 'Add authentication',
        });
        expect(features[2]).toMatchObject({
          id: 'feature-3',
          description: 'Build API endpoints',
        });
      });

      it('should parse numbered list with parentheses (1))', () => {
        const task = `
1) First feature
2) Second feature
3) Third feature
        `;

        const features = generateFeatureList(task);

        expect(features).toHaveLength(3);
        expect(features[0].description).toBe('First feature');
        expect(features[1].description).toBe('Second feature');
        expect(features[2].description).toBe('Third feature');
      });

      it('should handle mixed spacing in numbered lists', () => {
        const task = `
1.  Feature with extra spaces
2.Feature without space
3.     Feature with many spaces
        `;

        const features = generateFeatureList(task);

        expect(features).toHaveLength(3);
        expect(features[0].description).toBe('Feature with extra spaces');
        expect(features[1].description).toBe('Feature without space');
        expect(features[2].description).toBe('Feature with many spaces');
      });
    });

    describe('bullet point parsing', () => {
      it('should parse dash bullet points', () => {
        const task = `
- First task
- Second task
- Third task
        `;

        const features = generateFeatureList(task);

        expect(features).toHaveLength(3);
        expect(features[0].description).toBe('First task');
        expect(features[1].description).toBe('Second task');
        expect(features[2].description).toBe('Third task');
      });

      it('should parse asterisk bullet points', () => {
        const task = `
* Build feature A
* Build feature B
* Build feature C
        `;

        const features = generateFeatureList(task);

        expect(features).toHaveLength(3);
        expect(features[0].description).toBe('Build feature A');
        expect(features[1].description).toBe('Build feature B');
        expect(features[2].description).toBe('Build feature C');
      });

      it('should handle mixed bullet styles', () => {
        const task = `
- First with dash
* Second with asterisk
- Third with dash again
        `;

        const features = generateFeatureList(task);

        expect(features).toHaveLength(3);
        expect(features[0].description).toBe('First with dash');
        expect(features[1].description).toBe('Second with asterisk');
        expect(features[2].description).toBe('Third with dash again');
      });
    });

    describe('keyword-based parsing', () => {
      it('should parse "feature:" prefix', () => {
        const task = `
feature: User authentication
feature: Password reset
        `;

        const features = generateFeatureList(task);

        expect(features).toHaveLength(2);
        expect(features[0].description).toBe('User authentication');
        expect(features[1].description).toBe('Password reset');
      });

      it('should parse "implement:" prefix', () => {
        const task = `
implement: OAuth2 login
implement: JWT tokens
        `;

        const features = generateFeatureList(task);

        expect(features).toHaveLength(2);
        expect(features[0].description).toBe('OAuth2 login');
      });

      it('should parse "add:" prefix', () => {
        const task = 'add: New dashboard widget';

        const features = generateFeatureList(task);

        expect(features).toHaveLength(1);
        expect(features[0].description).toBe('New dashboard widget');
      });

      it('should parse "create:" prefix', () => {
        const task = 'create: Database migrations';

        const features = generateFeatureList(task);

        expect(features[0].description).toBe('Database migrations');
      });

      it('should parse "build:" prefix', () => {
        const task = 'build: Frontend components';

        const features = generateFeatureList(task);

        expect(features[0].description).toBe('Frontend components');
      });

      it('should parse "fix:" prefix', () => {
        const task = 'fix: Memory leak in worker pool';

        const features = generateFeatureList(task);

        expect(features[0].description).toBe('Memory leak in worker pool');
      });

      it('should parse "update:" prefix', () => {
        const task = 'update: Dependencies to latest versions';

        const features = generateFeatureList(task);

        expect(features[0].description).toBe('Dependencies to latest versions');
      });

      it('should be case insensitive for keywords', () => {
        const task = `
FEATURE: Uppercase keyword
Feature: Mixed case keyword
feature: Lowercase keyword
        `;

        const features = generateFeatureList(task);

        expect(features).toHaveLength(3);
        expect(features[0].description).toBe('Uppercase keyword');
        expect(features[1].description).toBe('Mixed case keyword');
        expect(features[2].description).toBe('Lowercase keyword');
      });
    });

    describe('mixed format parsing', () => {
      it('should handle mixed numbered and bullet lists', () => {
        const task = `
1. First numbered item
- Bullet item
2. Second numbered item
* Another bullet
        `;

        const features = generateFeatureList(task);

        expect(features).toHaveLength(4);
        expect(features[0].description).toBe('First numbered item');
        expect(features[1].description).toBe('Bullet item');
        expect(features[2].description).toBe('Second numbered item');
        expect(features[3].description).toBe('Another bullet');
      });

      it('should handle numbered list with keyword features', () => {
        const task = `
1. First item
feature: Explicit feature
2. Second item
        `;

        const features = generateFeatureList(task);

        expect(features).toHaveLength(3);
      });
    });

    describe('fallback behavior', () => {
      it('should create single feature for unstructured text', () => {
        const task = 'Build a complete user management system with authentication';

        const features = generateFeatureList(task);

        expect(features).toHaveLength(1);
        expect(features[0]).toMatchObject({
          id: 'feature-1',
          description: 'Build a complete user management system with authentication',
          status: 'pending',
          attempts: 0,
        });
      });

      it('should truncate long unstructured task to 200 chars', () => {
        const longTask = 'a'.repeat(250);

        const features = generateFeatureList(longTask);

        expect(features).toHaveLength(1);
        expect(features[0].description).toHaveLength(203); // 200 + "..."
        expect(features[0].description).toBe('a'.repeat(200) + '...');
      });

      it('should not truncate if exactly 200 chars', () => {
        const task = 'a'.repeat(200);

        const features = generateFeatureList(task);

        expect(features[0].description).toBe(task);
        expect(features[0].description).not.toContain('...');
      });

      it('should not add ellipsis if under 200 chars', () => {
        const task = 'Short task';

        const features = generateFeatureList(task);

        expect(features[0].description).toBe('Short task');
        expect(features[0].description).not.toContain('...');
      });
    });

    describe('edge cases', () => {
      it('should handle empty string', () => {
        const features = generateFeatureList('');

        expect(features).toHaveLength(1);
        expect(features[0]).toMatchObject({
          id: 'feature-1',
          description: '',
          status: 'pending',
          attempts: 0,
        });
      });

      it('should handle whitespace-only string', () => {
        const features = generateFeatureList('   \n\n   \t   ');

        expect(features).toHaveLength(1);
        expect(features[0].description).toBe('   \n\n   \t   '); // Preserved in fallback
      });

      it('should ignore empty lines in structured format', () => {
        const task = `
1. First item

2. Second item

        `;

        const features = generateFeatureList(task);

        expect(features).toHaveLength(2);
      });

      it('should handle lines with only numbers/bullets', () => {
        const task = `
1.
2. Valid item
-
* Another valid item
        `;

        const features = generateFeatureList(task);

        // Lines with only markers should create empty description features
        expect(features).toHaveLength(4);
        expect(features[0].description).toBe('');
        expect(features[1].description).toBe('Valid item');
        expect(features[2].description).toBe('');
        expect(features[3].description).toBe('Another valid item');
      });

      it('should preserve internal formatting in descriptions', () => {
        const task = '1. Add API endpoint `/users/:id` with auth';

        const features = generateFeatureList(task);

        expect(features[0].description).toBe('Add API endpoint `/users/:id` with auth');
      });

      it('should handle Unicode characters', () => {
        const task = '1. 实现用户认证 (Implement user authentication)';

        const features = generateFeatureList(task);

        expect(features[0].description).toBe('实现用户认证 (Implement user authentication)');
      });

      it('should generate sequential IDs', () => {
        const task = `
1. First
2. Second
3. Third
4. Fourth
5. Fifth
        `;

        const features = generateFeatureList(task);

        expect(features[0].id).toBe('feature-1');
        expect(features[1].id).toBe('feature-2');
        expect(features[2].id).toBe('feature-3');
        expect(features[3].id).toBe('feature-4');
        expect(features[4].id).toBe('feature-5');
      });
    });

    describe('real-world examples', () => {
      it('should parse typical feature list from user', () => {
        const task = `
Build a blog system with the following features:

1. Create blog post CRUD endpoints
2. Add markdown rendering
3. Implement user comments
4. Add like/favorite functionality
5. Create RSS feed generation
        `;

        const features = generateFeatureList(task);

        expect(features).toHaveLength(5);
        expect(features[0].description).toBe('Create blog post CRUD endpoints');
        expect(features[4].description).toBe('Create RSS feed generation');
      });

      it('should handle GitHub-style task lists', () => {
        const task = `
- [x] Setup project structure
- [ ] Implement core functionality
- [ ] Add tests
- [ ] Write documentation
        `;

        const features = generateFeatureList(task);

        expect(features).toHaveLength(4);
        // Checkbox markers should be preserved in description
        expect(features[0].description).toContain('[x]');
        expect(features[1].description).toContain('[ ]');
      });
    });
  });

  describe('DECOMPOSITION_PROMPT', () => {
    it('should be a non-empty string', () => {
      expect(DECOMPOSITION_PROMPT).toBeDefined();
      expect(typeof DECOMPOSITION_PROMPT).toBe('string');
      expect(DECOMPOSITION_PROMPT.length).toBeGreaterThan(0);
    });

    it('should contain guidance keywords', () => {
      expect(DECOMPOSITION_PROMPT).toContain('discrete');
      expect(DECOMPOSITION_PROMPT).toContain('Independently testable');
      expect(DECOMPOSITION_PROMPT).toContain('numbered list');
    });

    it('should include example format', () => {
      expect(DECOMPOSITION_PROMPT).toContain('Example format');
      expect(DECOMPOSITION_PROMPT).toMatch(/\d+\./); // Contains numbered examples
    });
  });
});
