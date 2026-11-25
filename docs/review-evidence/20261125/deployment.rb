# Offline checks for findings 3 and 18. Requires Ruby, Git, Bash, and Docker Compose.
require 'yaml'
require 'json'
require 'open3'
require 'tmpdir'

ROOT = File.expand_path('../../..', __dir__)
ENVIRONMENT = { 'PATH' => ENV.fetch('PATH'), 'LC_ALL' => 'C' }.freeze

def run(*argv, dir: ROOT, env: {})
  out, err, status = Open3.capture3(ENVIRONMENT.merge(env), *argv, chdir: dir, unsetenv_others: true)
  raise "#{argv.first} exited #{status.exitstatus}: #{err}" unless status.success?
  out
end

def database(file, service, env = {})
  raw = run('docker', 'compose', '--env-file', File::NULL, '-f', file, 'config', '--format', 'json', env: env)
  JSON.parse(raw).fetch('services').fetch(service)
end

[['docker-compose.dev.yml', 'postgres', '5432'], ['docker-compose.test.yml', 'postgres-test', '5433']].each do |file, name, port|
  db = database(file, name)
  mapping = db.fetch('ports').fetch(0)
  raise 'port differs' unless mapping['published'].to_s == port && mapping['target'] == 5432
  raise 'an explicit host address was supplied' if mapping['host_ip']
  raise 'credential defaults differ' unless db.fetch('environment').values_at('POSTGRES_USER', 'POSTGRES_PASSWORD') == %w[koda koda]
  puts "03  #{file}: port=#{port}->5432 host_ip=unspecified, repository credential defaults verified"
end
override = database('docker-compose.dev.yml', 'postgres', 'POSTGRES_PASSWORD' => 'fixture-override')
raise unless override.fetch('environment').fetch('POSTGRES_PASSWORD') == 'fixture-override'
sample = %w[JWT_SECRET JWT_REFRESH_SECRET API_KEY_SECRET POSTGRES_PASSWORD].to_h { |k| [k, "fixture-#{k}"] }
raise if database('docker-compose.yml', 'postgres', sample).key?('ports')
puts '03  controls: dev accepts a password override; main Compose publishes no PostgreSQL port'

workflow = YAML.safe_load(File.read(File.join(ROOT, '.github/workflows/ci.yml')))
events = workflow['on'] || workflow.fetch(true) # Psych versions that parse YAML 1.1 resolve "on" to true.
push_paths = events.fetch('push').fetch('paths')
jobs = workflow.fetch('jobs')
filter = jobs.fetch('changes').fetch('steps').find { |step| step['id'] == 'filter' }.fetch('run')
gated = jobs.reject { |name, _| name == 'changes' }
raise 'inspect revised job gates' unless gated.values.all? { |job| job.fetch('if').include?("needs.changes.outputs.code == 'true'") }

Dir.mktmpdir('koda-ci-proof') do |dir|
  git_env = { 'GIT_CONFIG_NOSYSTEM' => '1', 'GIT_CONFIG_GLOBAL' => File::NULL,
              'GIT_AUTHOR_NAME' => 'Reviewer', 'GIT_COMMITTER_NAME' => 'Reviewer',
              'GIT_AUTHOR_EMAIL' => 'fixture@example.invalid', 'GIT_COMMITTER_EMAIL' => 'fixture@example.invalid' }
  git = ->(*args) { run('git', '-c', 'core.hooksPath=/dev/null', *args, dir: dir, env: git_env).strip }
  git.call('init', '--quiet', '--template=')
  git.call('commit', '--quiet', '--allow-empty', '-m', 'base')
  %w[docker-compose.dev.yml docker-compose.test.yml docker-compose.yml].each do |file|
    base = git.call('rev-parse', 'HEAD')
    File.write(File.join(dir, file), "services: {}\n")
    git.call('add', file)
    git.call('commit', '--quiet', '-m', 'one path')
    output = File.join(dir, 'step-output')
    File.write(output, '')
    run('bash', '-c', filter, dir: dir, env: git_env.merge('EVENT_NAME' => 'pull_request',
        'BASE_SHA' => base, 'HEAD_SHA' => git.call('rev-parse', 'HEAD'), 'GITHUB_OUTPUT' => output))
    pr = File.read(output).strip
    # These samples are top-level ASCII filenames; no directory or negation glob is involved.
    push = push_paths.any? { |pattern| File.fnmatch?(pattern, file, File::FNM_PATHNAME) }
    expected = file == 'docker-compose.yml'
    raise 'change policy differs' unless pr == "code=#{expected}" && push == expected
    puts "18  #{file}: real PR step #{pr}; push paths match=#{push}"
  end
  puts "18  #{gated.size} downstream CI jobs gate on the change result"
end
