const request = require('supertest');
const { AppFactory } = require('@nathapp/nestjs-app');
const AppModule = require('./src/app.module').AppModule;
const { CombinedAuthGuard } = require('./src/auth/guards/combined-auth.guard');
const { PrismaService } = require('@nathapp/nestjs-prisma');

async function test() {
  const app = await AppFactory.create(AppModule);
  const combinedGuard = app.get(CombinedAuthGuard);
  app.setJwtAuthGuard(combinedGuard);
  app.useAppGlobalPrefix().useAppGlobalPipes().useAppGlobalFilters().useAppGlobalGuards();
  
  await app.init();
  const httpServer = app.getHttpServer();
  const prisma = app.get(PrismaService);
  
  try {
    // Register user
    const registerRes = await request(httpServer)
      .post('/api/auth/register')
      .send({ email: `test-${Date.now()}@koda.test`, name: 'Test', password: 'Test1234!' });
    
    console.log('Register status:', registerRes.status);
    console.log('Register body:', registerRes.body);
    
    if (registerRes.status !== 201) {
      console.log('Register failed!');
      return;
    }
    
    const token = registerRes.body.data.accessToken;
    const userId = registerRes.body.data.user.id;
    
    // Promote to ADMIN
    await prisma.client.user.update({ where: { id: userId }, data: { role: 'ADMIN' } });
    
    // Create project
    const slug = `test-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const key = `TST${Date.now()}${Math.random().toString(36).substring(2, 5).toUpperCase()}`;
    
    console.log('Creating project with slug:', slug, 'key:', key);
    
    const projectRes = await request(httpServer)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Test Project',
        slug,
        key,
      });
    
    console.log('Project status:', projectRes.status);
    console.log('Project body:', projectRes.body);
  } finally {
    await app.close();
  }
}

test().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
