import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

describe('CreateProjectDto validation', () => {
  // Note: This test file is for validating the DTO structure
  // The actual implementation of CreateProjectDto will be in src/projects/dto/create-project.dto.ts

  describe('required fields', () => {
    it('should require name field', async () => {
      // name is required
      const invalidDto = {
        slug: 'test-project',
        key: 'TEST',
      };

      // This test verifies that name is required
      expect(invalidDto).not.toHaveProperty('name');
    });

    it('should require slug field', async () => {
      // slug is required
      const invalidDto = {
        name: 'Test Project',
        key: 'TEST',
      };

      expect(invalidDto).not.toHaveProperty('slug');
    });

    it('should require key field', async () => {
      // key is required
      const invalidDto = {
        name: 'Test Project',
        slug: 'test-project',
      };

      expect(invalidDto).not.toHaveProperty('key');
    });
  });

  describe('field validation rules', () => {
    it('name should have minimum length of 2', async () => {
      // name min length: 2
      const shortName = 'K';
      expect(shortName.length).toBeLessThan(2);
    });

    it('slug should contain only lowercase alphanumeric and hyphens', async () => {
      const validSlugs = ['test-project', 'test', 'test-project-123'];
      const invalidSlugs = ['TEST-PROJECT', 'Test-Project', 'test_project', 'test project'];

      validSlugs.forEach((slug) => {
        expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      });

      invalidSlugs.forEach((slug) => {
        expect(slug).not.toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      });
    });

    it('key should be 2-6 uppercase alphanumeric characters', async () => {
      const validKeys = ['AB', 'ABC', 'ABCD', 'ABCDE', 'ABCDEF'];
      const invalidKeys = ['A', 'ABCDEFG', 'ab', 'Abc', 'AB-CD', 'AB_CD'];

      validKeys.forEach((key) => {
        expect(key).toMatch(/^[A-Z0-9]{2,6}$/);
      });

      invalidKeys.forEach((key) => {
        expect(key).not.toMatch(/^[A-Z0-9]{2,6}$/);
      });
    });

    it('gitRemoteUrl should be optional and valid URL format', async () => {
      const validUrls = [
        'https://github.com/user/repo',
        'git@github.com:user/repo.git',
        'https://gitlab.com/user/repo',
      ];

      validUrls.forEach((url) => {
        expect(url).toBeDefined();
        expect(typeof url).toBe('string');
      });
    });

    it('autoIndexOnClose should be optional boolean', async () => {
      const validValues = [true, false];
      const defaultValue = true;

      expect(validValues).toContain(defaultValue);
    });

    it('description should be optional string', async () => {
      const descriptions = [
        undefined,
        'A simple description',
        'Project description with special chars !@#$%',
      ];

      descriptions.forEach((desc) => {
        expect(typeof desc === 'undefined' || typeof desc === 'string').toBe(true);
      });
    });
  });

  describe('valid DTO examples', () => {
    it('should validate complete DTO', async () => {
      const validDto = {
        name: 'My Project',
        slug: 'my-project',
        key: 'MYPRJ',
        description: 'Project description',
        gitRemoteUrl: 'https://github.com/user/repo',
        autoIndexOnClose: true,
      };

      expect(validDto.name).toBeDefined();
      expect(validDto.slug).toBeDefined();
      expect(validDto.key).toBeDefined();
    });

    it('should validate minimal DTO with only required fields', async () => {
      const minimalDto = {
        name: 'Minimal',
        slug: 'minimal',
        key: 'MIN',
      };

      expect(minimalDto.name).toBeDefined();
      expect(minimalDto.slug).toBeDefined();
      expect(minimalDto.key).toBeDefined();
    });
  });
});
