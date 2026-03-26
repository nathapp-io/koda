# Contributing to Koda

Thanks for your interest in contributing to Koda! This guide will help you get started.

## Development Setup

### Prerequisites

- [Node.js](https://nodejs.org/) v22+
- [Bun](https://bun.sh/) v1.0+
- Git

### Getting Started

```bash
# Clone the repo
git clone https://github.com/nathapp-io/koda.git
cd koda

# Install dependencies
bun install

# Generate Prisma client
bun run db:generate

# Run database migrations
bun run db:migrate

# Start development servers
bun run dev
```

### Project Structure

```
koda/
├── apps/
│   ├── api/        # NestJS + Fastify backend
│   ├── web/        # Nuxt + Shadcn-nuxt frontend
│   └── cli/        # Commander.js CLI
├── packages/       # Shared packages
├── prisma/         # Database schema
└── docker-compose.yml
```

## Making Changes

### Branch Naming

- `feat/<description>` — new features
- `fix/<description>` — bug fixes
- `docs/<description>` — documentation
- `chore/<description>` — maintenance

### Workflow

1. Fork the repo and create your branch from `main`
2. Make your changes
3. Add or update tests as needed
4. Ensure all checks pass:

```bash
bun run type-check
bun run lint
bun run test
```

5. Open a Pull Request using the PR template

### Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(api): add ticket priority field
fix(cli): handle missing config file gracefully
docs: update installation guide
chore(deps): bump dependencies
```

### Code Style

- TypeScript strict mode
- Prettier for formatting
- ESLint for linting
- Run `bun run lint` before committing

## Pull Requests

- Fill in the PR template completely
- Link related issues with `Closes #123`
- Keep PRs focused — one feature or fix per PR
- Add tests for new functionality
- Update documentation if behavior changes

## Reporting Issues

- **Bugs:** Use the [Bug Report](https://github.com/nathapp-io/koda/issues/new?template=bug_report.md) template
- **Features:** Use the [Feature Request](https://github.com/nathapp-io/koda/issues/new?template=feature_request.md) template
- **Security:** See [SECURITY.md](SECURITY.md)

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
