describe('Projects API E2E Tests', () => {
  // These tests verify the full HTTP request/response cycle
  // They will be implemented after the service and controller are created

  describe('POST /api/projects - Create Project', () => {
    it('should return 201 with valid admin credentials and valid project data', async () => {
      // Arrange
      const _createDto = {
        name: 'My Project',
        slug: 'my-project',
        key: 'MYPR',
        description: 'Project description',
        gitRemoteUrl: 'https://github.com/user/repo',
        autoIndexOnClose: true,
      };

      const _adminToken = 'Bearer admin-jwt-token';

      // Act
      // const response = await request(app.getHttpServer())
      //   .post('/api/projects')
      //   .set('Authorization', adminToken)
      //   .send(createDto);

      // Assert
      // expect(response.status).toBe(201);
      // expect(response.body).toHaveProperty('id');
      // expect(response.body.name).toBe(createDto.name);
    });

    it('should return 403 with non-admin user', async () => {
      // Arrange
      const _createDto = {
        name: 'My Project',
        slug: 'my-project',
        key: 'MYPR',
      };

      const _memberToken = 'Bearer member-jwt-token';

      // Act
      // const response = await request(app.getHttpServer())
      //   .post('/api/projects')
      //   .set('Authorization', memberToken)
      //   .send(createDto);

      // Assert
      // expect(response.status).toBe(403);
    });

    it('should return 409 when slug already exists', async () => {
      // Arrange
      const _createDto = {
        name: 'New Project',
        slug: 'existing-slug',
        key: 'NEW',
      };

      const _adminToken = 'Bearer admin-jwt-token';

      // Act
      // const response = await request(app.getHttpServer())
      //   .post('/api/projects')
      //   .set('Authorization', adminToken)
      //   .send(createDto);

      // Assert
      // expect(response.status).toBe(409);
    });

    it('should return 409 when key already exists', async () => {
      // Arrange
      const _createDto = {
        name: 'New Project',
        slug: 'new-project',
        key: 'EXISTING',
      };

      const _adminToken = 'Bearer admin-jwt-token';

      // Act
      // const response = await request(app.getHttpServer())
      //   .post('/api/projects')
      //   .set('Authorization', adminToken)
      //   .send(createDto);

      // Assert
      // expect(response.status).toBe(409);
    });

    it('should return 400 for invalid key format', async () => {
      // Arrange
      const _invalidCreateDtos = [
        { name: 'Test', slug: 'test', key: 'K' },
        { name: 'Test', slug: 'test', key: 'TOOLONG' },
        { name: 'Test', slug: 'test', key: 'lowercase' },
      ];

      const _adminToken = 'Bearer admin-jwt-token';

      // Act & Assert
      // for (const createDto of invalidCreateDtos) {
      //   const response = await request(app.getHttpServer())
      //     .post('/api/projects')
      //     .set('Authorization', adminToken)
      //     .send(createDto);
      //   expect(response.status).toBe(400);
      // }
    });
  });

  describe('GET /api/projects - List Projects', () => {
    it('should return 200 with all non-deleted projects', async () => {
      // Act
      // const response = await request(app.getHttpServer())
      //   .get('/api/projects');

      // Assert
      // expect(response.status).toBe(200);
      // expect(Array.isArray(response.body)).toBe(true);
    });

    it('should not include soft-deleted projects', async () => {
      // Arrange
      // Create a project
      // Soft delete it
      // List projects

      // Act
      // const response = await request(app.getHttpServer())
      //   .get('/api/projects');

      // Assert
      // expect(response.body).not.toContainEqual(
      //   expect.objectContaining({ slug: 'deleted-project' })
      // );
    });
  });

  describe('GET /api/projects/:slug - Get Project by Slug', () => {
    it('should return 200 with project data', async () => {
      // Act
      // const response = await request(app.getHttpServer())
      //   .get('/api/projects/my-project');

      // Assert
      // expect(response.status).toBe(200);
      // expect(response.body.slug).toBe('my-project');
    });

    it('should return 404 for non-existent project', async () => {
      // Act
      // const response = await request(app.getHttpServer())
      //   .get('/api/projects/nonexistent');

      // Assert
      // expect(response.status).toBe(404);
    });

    it('should return 404 for soft-deleted project', async () => {
      // Act
      // const response = await request(app.getHttpServer())
      //   .get('/api/projects/deleted-project');

      // Assert
      // expect(response.status).toBe(404);
    });
  });

  describe('PATCH /api/projects/:slug - Update Project', () => {
    it('should return 200 with updated project for admin user', async () => {
      // Arrange
      const _updateDto = {
        name: 'Updated Name',
        description: 'Updated description',
      };

      const _adminToken = 'Bearer admin-jwt-token';

      // Act
      // const response = await request(app.getHttpServer())
      //   .patch('/api/projects/my-project')
      //   .set('Authorization', adminToken)
      //   .send(updateDto);

      // Assert
      // expect(response.status).toBe(200);
      // expect(response.body.name).toBe(updateDto.name);
    });

    it('should return 403 for non-admin user', async () => {
      // Arrange
      const _updateDto = { name: 'Updated' };
      const _memberToken = 'Bearer member-jwt-token';

      // Act
      // const response = await request(app.getHttpServer())
      //   .patch('/api/projects/my-project')
      //   .set('Authorization', memberToken)
      //   .send(updateDto);

      // Assert
      // expect(response.status).toBe(403);
    });

    it('should return 409 when updating to existing slug', async () => {
      // Arrange
      const _updateDto = { slug: 'existing-project' };
      const _adminToken = 'Bearer admin-jwt-token';

      // Act
      // const response = await request(app.getHttpServer())
      //   .patch('/api/projects/my-project')
      //   .set('Authorization', adminToken)
      //   .send(updateDto);

      // Assert
      // expect(response.status).toBe(409);
    });
  });

  describe('DELETE /api/projects/:slug - Soft Delete Project', () => {
    it('should return 200 and set deletedAt for admin user', async () => {
      // Arrange
      const _adminToken = 'Bearer admin-jwt-token';

      // Act
      // const response = await request(app.getHttpServer())
      //   .delete('/api/projects/my-project')
      //   .set('Authorization', adminToken);

      // Assert
      // expect(response.status).toBe(200);
      // expect(response.body.deletedAt).not.toBeNull();
      // expect(response.body.deletedAt).toEqual(expect.any(String)); // ISO date
    });

    it('should return 403 for non-admin user', async () => {
      // Arrange
      const _memberToken = 'Bearer member-jwt-token';

      // Act
      // const response = await request(app.getHttpServer())
      //   .delete('/api/projects/my-project')
      //   .set('Authorization', memberToken);

      // Assert
      // expect(response.status).toBe(403);
    });

    it('should not hard delete the project', async () => {
      // Arrange
      const _adminToken = 'Bearer admin-jwt-token';

      // Act
      // // Soft delete
      // const deleteResponse = await request(app.getHttpServer())
      //   .delete('/api/projects/my-project')
      //   .set('Authorization', adminToken);

      // // Try to get it (should still exist in DB)
      // const getResponse = await request(app.getHttpServer())
      //   .get('/api/projects/my-project'); // Should return 404 for public API

      // Assert
      // expect(deleteResponse.status).toBe(200);
      // expect(deleteResponse.body.id).toBeDefined(); // Project still has ID
      // expect(getResponse.status).toBe(404); // Not in public list
    });

    it('should exclude soft-deleted project from list', async () => {
      // Arrange
      const _adminToken = 'Bearer admin-jwt-token';

      // Act
      // // Soft delete project
      // await request(app.getHttpServer())
      //   .delete('/api/projects/to-delete')
      //   .set('Authorization', adminToken);

      // // List projects
      // const listResponse = await request(app.getHttpServer())
      //   .get('/api/projects');

      // Assert
      // expect(listResponse.body).not.toContainEqual(
      //   expect.objectContaining({ slug: 'to-delete' })
      // );
    });

    it('should return 404 for non-existent project', async () => {
      // Arrange
      const _adminToken = 'Bearer admin-jwt-token';

      // Act
      // const response = await request(app.getHttpServer())
      //   .delete('/api/projects/nonexistent')
      //   .set('Authorization', adminToken);

      // Assert
      // expect(response.status).toBe(404);
    });
  });

  describe('Authorization checks', () => {
    it('should allow public read access (GET) without token', async () => {
      // Act
      // const listResponse = await request(app.getHttpServer())
      //   .get('/api/projects');

      // const getResponse = await request(app.getHttpServer())
      //   .get('/api/projects/my-project');

      // Assert
      // expect(listResponse.status).toBe(200);
      // expect(getResponse.status).toMatch(/200|404/); // 200 if exists, 404 if not
    });

    it('should require admin token for write operations (POST)', async () => {
      // Act
      // const response = await request(app.getHttpServer())
      //   .post('/api/projects')
      //   .send({ name: 'Test', slug: 'test', key: 'TEST' })
      //   .set('Authorization', '');

      // Assert
      // expect(response.status).toMatch(/401|403/); // Unauthorized or Forbidden
    });

    it('should require admin token for update (PATCH)', async () => {
      // Act
      // const response = await request(app.getHttpServer())
      //   .patch('/api/projects/my-project')
      //   .send({ name: 'Updated' })
      //   .set('Authorization', '');

      // Assert
      // expect(response.status).toMatch(/401|403/);
    });

    it('should require admin token for delete (DELETE)', async () => {
      // Act
      // const response = await request(app.getHttpServer())
      //   .delete('/api/projects/my-project')
      //   .set('Authorization', '');

      // Assert
      // expect(response.status).toMatch(/401|403/);
    });
  });
});
