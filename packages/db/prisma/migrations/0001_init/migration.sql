-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('admin', 'viewer');

-- CreateEnum
CREATE TYPE "TokenScope" AS ENUM ('read', 'deploy', 'admin');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('user', 'token', 'system', 'webhook');

-- CreateEnum
CREATE TYPE "IngressMode" AS ENUM ('cloudflare_tunnel', 'direct_tls');

-- CreateEnum
CREATE TYPE "SecretKind" AS ENUM ('totp', 'env_var', 'env_snapshot', 'env_version', 'integration_token', 'storage_secret_key', 'channel_url', 'github_private_key', 'github_webhook_secret', 'backup_key', 'database_password', 'email_message');

-- CreateEnum
CREATE TYPE "IntegrationKind" AS ENUM ('github_app', 'vercel', 'cloudflare', 'registry', 'storage', 'channel', 'email');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('connected', 'disconnected', 'error');

-- CreateEnum
CREATE TYPE "AppKind" AS ENUM ('frontend', 'backend', 'bot', 'postgres', 'redis', 's3');

-- CreateEnum
CREATE TYPE "AppStatus" AS ENUM ('running', 'stopped', 'deploying', 'degraded', 'unknown');

-- CreateEnum
CREATE TYPE "DesiredState" AS ENUM ('running', 'stopped');

-- CreateEnum
CREATE TYPE "DeployTarget" AS ENUM ('server', 'vercel');

-- CreateEnum
CREATE TYPE "IconChoice" AS ENUM ('auto', 'upload');

-- CreateEnum
CREATE TYPE "IconSource" AS ENUM ('favicon', 'upload');

-- CreateEnum
CREATE TYPE "Capability" AS ENUM ('NET_ADMIN', 'NET_RAW');

-- CreateEnum
CREATE TYPE "EnvScope" AS ENUM ('project', 'environment', 'app');

-- CreateEnum
CREATE TYPE "EnvTarget" AS ENUM ('build', 'runtime', 'both');

-- CreateEnum
CREATE TYPE "EnvVersionSource" AS ENUM ('dashboard', 'api', 'rollback');

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('queued', 'building', 'deploying', 'ready', 'failed', 'cancelling', 'cancelled');

-- CreateEnum
CREATE TYPE "DeploymentTrigger" AS ENUM ('manual', 'push', 'api', 'redeploy', 'rollback', 'preview');

-- CreateEnum
CREATE TYPE "TlsStatus" AS ENUM ('active', 'pending', 'failed');

-- CreateEnum
CREATE TYPE "DnsStatus" AS ENUM ('ok', 'mismatch', 'missing', 'unchecked');

-- CreateEnum
CREATE TYPE "PreviewStatus" AS ENUM ('building', 'ready', 'asleep', 'failed', 'blocked', 'closing', 'closed');

-- CreateEnum
CREATE TYPE "BackupKind" AS ENUM ('postgres', 'redis', 'volume', 'control_plane');

-- CreateEnum
CREATE TYPE "BackupTrigger" AS ENUM ('schedule', 'manual', 'pre_deploy', 'pre_update', 'pre_restore');

-- CreateEnum
CREATE TYPE "BackupStatus" AS ENUM ('running', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "BackupDestinationType" AS ENUM ('local', 's3');

-- CreateEnum
CREATE TYPE "RestoreTestStatus" AS ENUM ('passed', 'failed', 'running', 'not_tested');

-- CreateEnum
CREATE TYPE "AlertMetric" AS ENUM ('disk', 'service', 'down', 'crash_loop', 'memory', 'http_5xx');

-- CreateEnum
CREATE TYPE "ControlService" AS ENUM ('any', 'api', 'worker', 'proxy', 'database');

-- CreateEnum
CREATE TYPE "AlertChannel" AS ENUM ('discord', 'webhook', 'email', 'bell');

-- CreateEnum
CREATE TYPE "AlertState" AS ENUM ('firing', 'resolved');

-- CreateEnum
CREATE TYPE "IncidentImpact" AS ENUM ('minor', 'major');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('investigating', 'identified', 'monitoring', 'resolved');

-- CreateEnum
CREATE TYPE "UpdatePhase" AS ENUM ('preflight', 'pull', 'backup', 'migrate', 'swap_api', 'swap_worker', 'swap_web', 'health', 'rollback');

-- CreateEnum
CREATE TYPE "UpdateState" AS ENUM ('waiting', 'running', 'done', 'failed', 'rolled_back');

-- CreateEnum
CREATE TYPE "UpdateKind" AS ENUM ('update', 'rollback');

-- CreateEnum
CREATE TYPE "UpdateTrigger" AS ENUM ('manual', 'auto', 'cli');

-- CreateEnum
CREATE TYPE "UpdateMode" AS ENUM ('manual', 'security', 'all');

-- CreateEnum
CREATE TYPE "ReleaseChannel" AS ENUM ('stable', 'beta');

-- CreateEnum
CREATE TYPE "JobKind" AS ENUM ('deploy', 'cancel_deploy', 'remove_app', 'backup', 'restore', 'restore_test', 'prune', 'janitor', 'reconcile', 'preview_cleanup', 'preview_feedback', 'preview_wake', 'preview_dns', 'self_update', 'dns_check', 'vercel_sync', 'edge_route_sync', 'edge_cf_wire', 'edge_cf_unwire', 'alert_notify', 'factory_reset', 'email_send', 'update_notify', 'app_power', 'icon_fetch', 'deploy_notify');

-- CreateEnum
CREATE TYPE "EmailCodePurpose" AS ENUM ('verify', 'change', 'password');

-- CreateEnum
CREATE TYPE "JobLane" AS ENUM ('deploy', 'data', 'maintenance', 'update');

-- CreateEnum
CREATE TYPE "CfDomainState" AS ENUM ('none', 'pending', 'managed', 'external', 'failed');

-- CreateEnum
CREATE TYPE "LogStream" AS ENUM ('stdout', 'stderr');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('error', 'warn', 'info', 'debug');

-- CreateEnum
CREATE TYPE "ActivityCategory" AS ENUM ('deploys', 'config', 'access', 'system');

-- CreateEnum
CREATE TYPE "MetricResolution" AS ENUM ('raw', 'five_min', 'hour');

-- CreateTable
CREATE TABLE "instance" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "publicUrl" TEXT NOT NULL,
    "masterKeyFingerprint" TEXT NOT NULL,
    "ingressMode" "IngressMode" NOT NULL DEFAULT 'cloudflare_tunnel',
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "buildConcurrency" INTEGER NOT NULL DEFAULT 1,
    "logRetentionDays" INTEGER NOT NULL DEFAULT 30,
    "notifyEvents" JSONB NOT NULL DEFAULT '{}',
    "setupCompletedAt" TIMESTAMPTZ(3),
    "releaseVersion" TEXT,
    "updateCheckedAt" TIMESTAMPTZ(3),
    "latestRelease" JSONB,
    "updateFeedSeenAt" TIMESTAMPTZ(3),
    "updateNextCheckAt" TIMESTAMPTZ(3),
    "updateCheckError" TEXT,
    "updateMode" "UpdateMode" NOT NULL DEFAULT 'all',
    "updateChannel" "ReleaseChannel" NOT NULL DEFAULT 'stable',
    "updateWindow" JSONB NOT NULL DEFAULT '{"days":[0,1,2,3,4,5,6],"start":"03:00","end":"05:00"}',
    "updateTimeZone" TEXT NOT NULL DEFAULT 'Etc/UTC',
    "updateSkipVersion" TEXT,
    "updatePausedUntil" TIMESTAMPTZ(3),
    "updateNotifiedVersion" TEXT,
    "backupKeySecretId" UUID,
    "restoreTestCron" TEXT NOT NULL DEFAULT '0 4 * * 0',
    "buildCacheCapBytes" BIGINT NOT NULL DEFAULT 10737418240,
    "pinnedImagesPerApp" INTEGER NOT NULL DEFAULT 3,
    "janitorLastRunAt" TIMESTAMPTZ(3),
    "janitorLastFreed" BIGINT,
    "backupKeyHistory" JSONB NOT NULL DEFAULT '[]',
    "workerSeenAt" TIMESTAMPTZ(3),
    "previewServerMax" INTEGER NOT NULL DEFAULT 4,
    "previewDomain" TEXT,
    "hostDisk" JSONB,
    "hostDiskAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "instance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "totpSecretId" UUID,
    "totpConfirmedAt" TIMESTAMPTZ(3),
    "totpLastUsedStep" INTEGER,
    "passwordChangedAt" TIMESTAMPTZ(3),
    "emailVerifiedAt" TIMESTAMPTZ(3),
    "githubLogin" TEXT,
    "githubVerifiedAt" TIMESTAMPTZ(3),
    "timeZone" TEXT,
    "hour12" BOOLEAN NOT NULL DEFAULT false,
    "emailDeployFailed" BOOLEAN NOT NULL DEFAULT true,
    "emailSecurity" BOOLEAN NOT NULL DEFAULT true,
    "disabledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "members" (
    "id" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "joinedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invites" (
    "id" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "invitedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "elevatedUntil" TIMESTAMPTZ(3),
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "absoluteExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_challenges" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "ip" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),

    CONSTRAINT "login_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trusted_devices" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "trusted_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_recovery_codes" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_codes" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "purpose" "EmailCodePurpose" NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),

    CONSTRAINT "email_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_resets" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "ip" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),

    CONSTRAINT "password_resets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scope" "TokenScope" NOT NULL,
    "expiresAt" TIMESTAMPTZ(3),
    "lastUsedAt" TIMESTAMPTZ(3),
    "lastUsedIp" TEXT,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "allProjects" BOOLEAN NOT NULL DEFAULT false,
    "grants" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_token_projects" (
    "tokenId" UUID NOT NULL,
    "projectId" UUID NOT NULL,

    CONSTRAINT "api_token_projects_pkey" PRIMARY KEY ("tokenId","projectId")
);

-- CreateTable
CREATE TABLE "secrets" (
    "id" UUID NOT NULL,
    "kind" "SecretKind" NOT NULL,
    "ownerType" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "kekId" TEXT NOT NULL,
    "wrappedDek" BYTEA NOT NULL,
    "dekNonce" BYTEA NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "ctNonce" BYTEA NOT NULL,
    "hint" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "secrets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrations" (
    "id" UUID NOT NULL,
    "kind" "IntegrationKind" NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secretId" UUID,
    "secondSecretId" UUID,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'connected',
    "error" TEXT,
    "lastCheckedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_installations" (
    "id" UUID NOT NULL,
    "installationId" BIGINT NOT NULL,
    "accountLogin" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "repositorySelection" TEXT NOT NULL,
    "selectedCount" INTEGER,
    "suspendedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "github_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "repoUrl" TEXT,
    "gitInstallationId" UUID,
    "gitRepoId" TEXT,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "autoDeploy" BOOLEAN NOT NULL DEFAULT true,
    "envVersion" INTEGER NOT NULL DEFAULT 0,
    "previewEnabled" BOOLEAN NOT NULL DEFAULT false,
    "previewBaseEnv" TEXT NOT NULL DEFAULT 'development',
    "previewMaxConcurrent" INTEGER NOT NULL DEFAULT 2,
    "previewDomain" TEXT,
    "previewCpuLimit" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "previewMemoryMb" INTEGER NOT NULL DEFAULT 512,
    "previewPidsLimit" INTEGER NOT NULL DEFAULT 128,
    "previewIdleMinutes" INTEGER NOT NULL DEFAULT 30,
    "previewTtlHours" INTEGER NOT NULL DEFAULT 72,
    "previewFromForks" BOOLEAN NOT NULL DEFAULT false,
    "previewIsolatedDb" BOOLEAN NOT NULL DEFAULT false,
    "iconChoice" "IconChoice" NOT NULL DEFAULT 'auto',
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "environments" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "environments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "apps" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "AppKind" NOT NULL,
    "status" "AppStatus" NOT NULL DEFAULT 'unknown',
    "desiredState" "DesiredState" NOT NULL DEFAULT 'running',
    "deployTarget" "DeployTarget" NOT NULL DEFAULT 'server',
    "vercelProjectId" TEXT,
    "image" TEXT,
    "registryId" UUID,
    "gitRepository" TEXT,
    "gitBranch" TEXT,
    "gitInstallationId" UUID,
    "gitRepoId" TEXT,
    "builder" TEXT NOT NULL DEFAULT 'auto',
    "framework" TEXT,
    "rootDir" TEXT,
    "dockerfilePath" TEXT,
    "buildCommand" TEXT,
    "startCommand" TEXT,
    "releaseCommand" TEXT,
    "port" INTEGER,
    "healthCheckPath" TEXT,
    "healthExpectedStatus" INTEGER NOT NULL DEFAULT 200,
    "healthTimeoutSeconds" INTEGER NOT NULL DEFAULT 5,
    "healthGraceSeconds" INTEGER NOT NULL DEFAULT 10,
    "healthIntervalSeconds" INTEGER NOT NULL DEFAULT 10,
    "healthWindowSeconds" INTEGER NOT NULL DEFAULT 120,
    "autoRollback" BOOLEAN NOT NULL DEFAULT true,
    "replicas" INTEGER NOT NULL DEFAULT 1,
    "cpuLimit" DOUBLE PRECISION,
    "memoryLimitMb" INTEGER,
    "pidsLimit" INTEGER,
    "capAdd" "Capability"[] DEFAULT ARRAY[]::"Capability"[],
    "sysctls" JSONB NOT NULL DEFAULT '{}',
    "previewEnabled" BOOLEAN,
    "passwordSecretId" UUID,
    "containerId" TEXT,
    "currentDeploymentId" UUID,
    "primaryDomainId" UUID,
    "pendingDeployAt" TIMESTAMPTZ(3),
    "quiescedByJobId" UUID,
    "vercelSync" JSONB,
    "backupEnabled" BOOLEAN NOT NULL DEFAULT false,
    "backupCron" TEXT,
    "backupTimezone" TEXT NOT NULL DEFAULT 'UTC',
    "backupRetentionDays" INTEGER NOT NULL DEFAULT 14,
    "backupDestinationId" UUID,
    "backupLastRunAt" TIMESTAMPTZ(3),
    "iconChoice" "IconChoice" NOT NULL DEFAULT 'auto',
    "faviconCheckedAt" TIMESTAMPTZ(3),
    "faviconError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "apps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "icon_images" (
    "id" UUID NOT NULL,
    "appId" UUID,
    "projectId" UUID,
    "source" "IconSource" NOT NULL,
    "mime" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "sha256" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "origin" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "icon_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "volumes" (
    "id" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "mountPath" TEXT NOT NULL,
    "sizeBytes" BIGINT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "volumes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domains" (
    "id" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "hostname" TEXT NOT NULL,
    "tlsStatus" "TlsStatus" NOT NULL DEFAULT 'pending',
    "tlsIssuer" TEXT,
    "tlsExpiresAt" TIMESTAMPTZ(3),
    "dnsStatus" "DnsStatus" NOT NULL DEFAULT 'unchecked',
    "dnsResolved" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dnsCheckedAt" TIMESTAMPTZ(3),
    "cfZoneId" TEXT,
    "cfRecordId" TEXT,
    "cfTunnelId" TEXT,
    "cfState" "CfDomainState" NOT NULL DEFAULT 'none',
    "cfMessage" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "env_vars" (
    "id" UUID NOT NULL,
    "scopeType" "EnvScope" NOT NULL,
    "scopeId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "secretId" UUID NOT NULL,
    "isSecret" BOOLEAN NOT NULL DEFAULT true,
    "target" "EnvTarget" NOT NULL DEFAULT 'both',
    "updatedById" UUID,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "env_vars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "env_versions" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT,
    "source" "EnvVersionSource" NOT NULL,
    "restoredFrom" INTEGER,
    "changes" JSONB NOT NULL,
    "redeployed" INTEGER NOT NULL DEFAULT 0,
    "snapshotSecretId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "env_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployments" (
    "id" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'queued',
    "trigger" "DeploymentTrigger" NOT NULL,
    "commitSha" TEXT,
    "branch" TEXT,
    "message" TEXT,
    "imageId" TEXT,
    "imageRef" TEXT,
    "imageDigest" TEXT,
    "rolledBack" BOOLEAN NOT NULL DEFAULT false,
    "releaseRanAt" TIMESTAMPTZ(3),
    "envSecretId" UUID,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT,
    "gitAuthor" TEXT,
    "gitAuthorAvatarUrl" TEXT,
    "rollbackOfId" UUID,
    "previewId" UUID,
    "error" TEXT,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "logSeq" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployment_log_chunks" (
    "deploymentId" UUID NOT NULL,
    "firstSeq" INTEGER NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "gzip" BYTEA NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployment_log_chunks_pkey" PRIMARY KEY ("deploymentId","firstSeq")
);

-- CreateTable
CREATE TABLE "preview_envs" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "baseEnvironmentId" UUID NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT,
    "branch" TEXT NOT NULL,
    "commitSha" TEXT,
    "repo" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "fromFork" BOOLEAN NOT NULL DEFAULT false,
    "isolatedDb" BOOLEAN NOT NULL DEFAULT false,
    "status" "PreviewStatus" NOT NULL DEFAULT 'building',
    "reason" TEXT,
    "error" TEXT,
    "commentId" TEXT,
    "feedbackAt" TIMESTAMPTZ(3),
    "lastCommitAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRequestAt" TIMESTAMPTZ(3),
    "requestCount" BIGINT,
    "sleptAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "closedAt" TIMESTAMPTZ(3),

    CONSTRAINT "preview_envs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preview_domains" (
    "domain" TEXT NOT NULL,
    "cfState" "CfDomainState" NOT NULL DEFAULT 'none',
    "cfMessage" TEXT,
    "cfZoneId" TEXT,
    "cfRecordId" TEXT,
    "cfTunnelId" TEXT,
    "dnsStatus" "DnsStatus" NOT NULL DEFAULT 'unchecked',
    "dnsDetail" TEXT,
    "dnsResolved" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "checkedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "preview_domains_pkey" PRIMARY KEY ("domain")
);

-- CreateTable
CREATE TABLE "preview_deployments" (
    "id" UUID NOT NULL,
    "envId" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "hostname" TEXT NOT NULL,
    "currentDeploymentId" UUID,
    "containerId" TEXT,
    "cpuPct" DOUBLE PRECISION,
    "memoryBytes" BIGINT,
    "sampledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "preview_deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_destinations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "BackupDestinationType" NOT NULL,
    "integrationId" UUID,
    "prefix" TEXT NOT NULL DEFAULT 'dockify/',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backup_destinations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backups" (
    "id" UUID NOT NULL,
    "appId" UUID,
    "sourceAppId" UUID NOT NULL,
    "appSnapshot" JSONB NOT NULL,
    "kind" "BackupKind" NOT NULL,
    "trigger" "BackupTrigger" NOT NULL,
    "status" "BackupStatus" NOT NULL DEFAULT 'running',
    "destinationId" UUID,
    "objectKey" TEXT,
    "sizeBytes" BIGINT,
    "sha256" TEXT,
    "encrypted" BOOLEAN NOT NULL DEFAULT true,
    "keyFingerprint" TEXT,
    "error" TEXT,
    "sourceTables" INTEGER,
    "sourceRows" BIGINT,
    "restoreTestStatus" "RestoreTestStatus" NOT NULL DEFAULT 'not_tested',
    "restoreTestedAt" TIMESTAMPTZ(3),
    "restoreTestTables" INTEGER,
    "restoreTestRows" BIGINT,
    "restoreTestError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),
    "expiredAt" TIMESTAMPTZ(3),

    CONSTRAINT "backups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_rules" (
    "id" UUID NOT NULL,
    "metric" "AlertMetric" NOT NULL,
    "appId" UUID,
    "service" "ControlService",
    "threshold" DOUBLE PRECISION,
    "durationMin" INTEGER NOT NULL DEFAULT 5,
    "channels" "AlertChannel"[] DEFAULT ARRAY['bell']::"AlertChannel"[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastFiredAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_events" (
    "id" UUID NOT NULL,
    "ruleId" UUID,
    "metric" "AlertMetric" NOT NULL,
    "appId" UUID,
    "service" "ControlService",
    "state" "AlertState" NOT NULL DEFAULT 'firing',
    "detail" TEXT NOT NULL,
    "href" TEXT NOT NULL,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),
    "notifiedAt" TIMESTAMPTZ(3),

    CONSTRAINT "alert_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_mutes" (
    "appId" UUID NOT NULL,
    "until" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_mutes_pkey" PRIMARY KEY ("appId")
);

-- CreateTable
CREATE TABLE "status_pages" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "title" TEXT,
    "logoUrl" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "status_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "status_page_items" (
    "id" UUID NOT NULL,
    "statusPageId" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "status_page_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "status_incidents" (
    "id" UUID NOT NULL,
    "statusPageId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "impact" "IncidentImpact" NOT NULL,
    "status" "IncidentStatus" NOT NULL,
    "affects" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updates" JSONB NOT NULL DEFAULT '[]',
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "resolvedAt" TIMESTAMPTZ(3),

    CONSTRAINT "status_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_uptime_days" (
    "appId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "downMinutes" INTEGER NOT NULL DEFAULT 0,
    "degradedMinutes" INTEGER NOT NULL DEFAULT 0,
    "sampledMinutes" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "app_uptime_days_pkey" PRIMARY KEY ("appId","day")
);

-- CreateTable
CREATE TABLE "terminal_tickets" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "sessionId" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "terminal_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "release_updates" (
    "id" UUID NOT NULL,
    "kind" "UpdateKind" NOT NULL DEFAULT 'update',
    "trigger" "UpdateTrigger" NOT NULL DEFAULT 'manual',
    "actorName" TEXT,
    "fromVersion" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "manifestSha256" TEXT,
    "fromImages" JSONB,
    "toImages" JSONB,
    "phase" "UpdatePhase" NOT NULL DEFAULT 'preflight',
    "state" "UpdateState" NOT NULL DEFAULT 'running',
    "dumpBackupId" UUID,
    "dumpSha256" TEXT,
    "dumpBytes" BIGINT,
    "migrationStarted" BOOLEAN NOT NULL DEFAULT false,
    "rollbackOfId" UUID,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "error" TEXT,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "release_updates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "kind" "JobKind" NOT NULL,
    "lane" "JobLane" NOT NULL DEFAULT 'deploy',
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT,
    "runAfter" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "lastError" TEXT,
    "lockedUntil" TIMESTAMPTZ(3),
    "lockedBy" TEXT,
    "completedAt" TIMESTAMPTZ(3),
    "failedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "projectId" UUID,
    "event" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "statusCode" INTEGER,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "redeliveryOf" UUID,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_samples" (
    "id" BIGSERIAL NOT NULL,
    "appId" UUID,
    "resolution" "MetricResolution" NOT NULL DEFAULT 'raw',
    "at" TIMESTAMPTZ(3) NOT NULL,
    "cpuPct" DOUBLE PRECISION NOT NULL,
    "memoryBytes" BIGINT NOT NULL,
    "pids" INTEGER,
    "restarts" INTEGER,
    "diskBytes" BIGINT,
    "netRxBytes" BIGINT,
    "netTxBytes" BIGINT,
    "memTotalBytes" BIGINT,
    "diskTotalBytes" BIGINT,

    CONSTRAINT "metric_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_log" (
    "id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "category" "ActivityCategory" NOT NULL,
    "action" TEXT NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT,
    "verb" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "targetLabel" TEXT,
    "targetHref" TEXT,
    "suffix" TEXT,
    "failed" BOOLEAN NOT NULL DEFAULT false,
    "ip" TEXT,
    "userAgent" TEXT,
    "gitAuthor" TEXT,
    "changes" JSONB,

    CONSTRAINT "activity_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runtime_log_lines" (
    "id" BIGSERIAL NOT NULL,
    "appId" UUID NOT NULL,
    "ts" TIMESTAMPTZ(3) NOT NULL,
    "stream" "LogStream" NOT NULL,
    "level" "LogLevel",
    "text" TEXT NOT NULL,

    CONSTRAINT "runtime_log_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_states" (
    "nonce" TEXT NOT NULL,
    "sessionId" UUID NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'install',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("nonce")
);

-- CreateIndex
CREATE UNIQUE INDEX "instance_backupKeySecretId_key" ON "instance"("backupKeySecretId");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_totpSecretId_key" ON "users"("totpSecretId");

-- CreateIndex
CREATE UNIQUE INDEX "users_githubLogin_key" ON "users"("githubLogin");

-- CreateIndex
CREATE UNIQUE INDEX "members_userId_key" ON "members"("userId");

-- CreateIndex
CREATE INDEX "members_teamId_idx" ON "members"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "invites_tokenHash_key" ON "invites"("tokenHash");

-- CreateIndex
CREATE INDEX "invites_teamId_idx" ON "invites"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "login_challenges_tokenHash_key" ON "login_challenges"("tokenHash");

-- CreateIndex
CREATE INDEX "login_challenges_userId_idx" ON "login_challenges"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "trusted_devices_tokenHash_key" ON "trusted_devices"("tokenHash");

-- CreateIndex
CREATE INDEX "trusted_devices_userId_idx" ON "trusted_devices"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_recovery_codes_userId_codeHash_key" ON "mfa_recovery_codes"("userId", "codeHash");

-- CreateIndex
CREATE INDEX "email_codes_userId_createdAt_idx" ON "email_codes"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "password_resets_tokenHash_key" ON "password_resets"("tokenHash");

-- CreateIndex
CREATE INDEX "password_resets_userId_idx" ON "password_resets"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "api_tokens_tokenHash_key" ON "api_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "api_tokens_userId_idx" ON "api_tokens"("userId");

-- CreateIndex
CREATE INDEX "api_token_projects_projectId_idx" ON "api_token_projects"("projectId");

-- CreateIndex
CREATE INDEX "secrets_ownerType_ownerId_idx" ON "secrets"("ownerType", "ownerId");

-- CreateIndex
CREATE INDEX "secrets_kekId_idx" ON "secrets"("kekId");

-- CreateIndex
CREATE UNIQUE INDEX "integrations_secretId_key" ON "integrations"("secretId");

-- CreateIndex
CREATE UNIQUE INDEX "integrations_secondSecretId_key" ON "integrations"("secondSecretId");

-- CreateIndex
CREATE UNIQUE INDEX "integrations_kind_name_key" ON "integrations"("kind", "name");

-- CreateIndex
CREATE UNIQUE INDEX "github_installations_installationId_key" ON "github_installations"("installationId");

-- CreateIndex
CREATE UNIQUE INDEX "projects_slug_key" ON "projects"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "environments_projectId_name_key" ON "environments"("projectId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "apps_passwordSecretId_key" ON "apps"("passwordSecretId");

-- CreateIndex
CREATE UNIQUE INDEX "apps_currentDeploymentId_key" ON "apps"("currentDeploymentId");

-- CreateIndex
CREATE UNIQUE INDEX "apps_primaryDomainId_key" ON "apps"("primaryDomainId");

-- CreateIndex
CREATE UNIQUE INDEX "apps_environmentId_name_key" ON "apps"("environmentId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "icon_images_appId_source_key" ON "icon_images"("appId", "source");

-- CreateIndex
CREATE UNIQUE INDEX "icon_images_projectId_source_key" ON "icon_images"("projectId", "source");

-- CreateIndex
CREATE UNIQUE INDEX "volumes_name_key" ON "volumes"("name");

-- CreateIndex
CREATE UNIQUE INDEX "volumes_appId_mountPath_key" ON "volumes"("appId", "mountPath");

-- CreateIndex
CREATE UNIQUE INDEX "domains_hostname_key" ON "domains"("hostname");

-- CreateIndex
CREATE INDEX "domains_appId_idx" ON "domains"("appId");

-- CreateIndex
CREATE UNIQUE INDEX "env_vars_secretId_key" ON "env_vars"("secretId");

-- CreateIndex
CREATE INDEX "env_vars_scopeId_idx" ON "env_vars"("scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "env_vars_scopeType_scopeId_key_key" ON "env_vars"("scopeType", "scopeId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "env_versions_snapshotSecretId_key" ON "env_versions"("snapshotSecretId");

-- CreateIndex
CREATE UNIQUE INDEX "env_versions_projectId_version_key" ON "env_versions"("projectId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "deployments_envSecretId_key" ON "deployments"("envSecretId");

-- CreateIndex
CREATE INDEX "deployments_appId_createdAt_idx" ON "deployments"("appId", "createdAt");

-- CreateIndex
CREATE INDEX "deployments_status_idx" ON "deployments"("status");

-- CreateIndex
CREATE INDEX "deployments_createdAt_idx" ON "deployments"("createdAt");

-- CreateIndex
CREATE INDEX "preview_envs_status_idx" ON "preview_envs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "preview_envs_projectId_prNumber_key" ON "preview_envs"("projectId", "prNumber");

-- CreateIndex
CREATE UNIQUE INDEX "preview_deployments_hostname_key" ON "preview_deployments"("hostname");

-- CreateIndex
CREATE UNIQUE INDEX "preview_deployments_currentDeploymentId_key" ON "preview_deployments"("currentDeploymentId");

-- CreateIndex
CREATE UNIQUE INDEX "preview_deployments_envId_appId_key" ON "preview_deployments"("envId", "appId");

-- CreateIndex
CREATE UNIQUE INDEX "backup_destinations_name_key" ON "backup_destinations"("name");

-- CreateIndex
CREATE UNIQUE INDEX "backup_destinations_integrationId_key" ON "backup_destinations"("integrationId");

-- CreateIndex
CREATE INDEX "backups_appId_createdAt_idx" ON "backups"("appId", "createdAt");

-- CreateIndex
CREATE INDEX "backups_sourceAppId_idx" ON "backups"("sourceAppId");

-- CreateIndex
CREATE INDEX "backups_createdAt_idx" ON "backups"("createdAt");

-- CreateIndex
CREATE INDEX "alert_rules_metric_idx" ON "alert_rules"("metric");

-- CreateIndex
CREATE INDEX "alert_events_state_startedAt_idx" ON "alert_events"("state", "startedAt");

-- CreateIndex
CREATE INDEX "alert_events_ruleId_startedAt_idx" ON "alert_events"("ruleId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "status_pages_projectId_key" ON "status_pages"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "status_page_items_statusPageId_appId_key" ON "status_page_items"("statusPageId", "appId");

-- CreateIndex
CREATE INDEX "status_incidents_statusPageId_startedAt_idx" ON "status_incidents"("statusPageId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "terminal_tickets_tokenHash_key" ON "terminal_tickets"("tokenHash");

-- CreateIndex
CREATE INDEX "release_updates_startedAt_idx" ON "release_updates"("startedAt");

-- CreateIndex
CREATE INDEX "jobs_lane_completedAt_failedAt_runAfter_idx" ON "jobs"("lane", "completedAt", "failedAt", "runAfter");

-- CreateIndex
CREATE INDEX "jobs_dedupeKey_idx" ON "jobs"("dedupeKey");

-- CreateIndex
CREATE INDEX "webhook_deliveries_projectId_receivedAt_idx" ON "webhook_deliveries"("projectId", "receivedAt");

-- CreateIndex
CREATE INDEX "webhook_deliveries_receivedAt_idx" ON "webhook_deliveries"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_provider_deliveryId_key" ON "webhook_deliveries"("provider", "deliveryId");

-- CreateIndex
CREATE INDEX "metric_samples_appId_resolution_at_idx" ON "metric_samples"("appId", "resolution", "at");

-- CreateIndex
CREATE INDEX "metric_samples_resolution_at_idx" ON "metric_samples"("resolution", "at");

-- CreateIndex
CREATE INDEX "activity_log_at_idx" ON "activity_log"("at");

-- CreateIndex
CREATE INDEX "activity_log_category_at_idx" ON "activity_log"("category", "at");

-- CreateIndex
CREATE INDEX "activity_log_actorType_actorId_at_idx" ON "activity_log"("actorType", "actorId", "at");

-- CreateIndex
CREATE INDEX "runtime_log_lines_appId_id_idx" ON "runtime_log_lines"("appId", "id");

-- CreateIndex
CREATE INDEX "runtime_log_lines_ts_idx" ON "runtime_log_lines"("ts");

-- CreateIndex
CREATE INDEX "oauth_states_expiresAt_idx" ON "oauth_states"("expiresAt");

-- AddForeignKey
ALTER TABLE "instance" ADD CONSTRAINT "instance_backupKeySecretId_fkey" FOREIGN KEY ("backupKeySecretId") REFERENCES "secrets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_totpSecretId_fkey" FOREIGN KEY ("totpSecretId") REFERENCES "secrets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "members" ADD CONSTRAINT "members_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "members" ADD CONSTRAINT "members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenges_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trusted_devices" ADD CONSTRAINT "trusted_devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_codes" ADD CONSTRAINT "email_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_token_projects" ADD CONSTRAINT "api_token_projects_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "api_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_token_projects" ADD CONSTRAINT "api_token_projects_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "secrets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_secondSecretId_fkey" FOREIGN KEY ("secondSecretId") REFERENCES "secrets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_gitInstallationId_fkey" FOREIGN KEY ("gitInstallationId") REFERENCES "github_installations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "environments" ADD CONSTRAINT "environments_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "apps" ADD CONSTRAINT "apps_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "apps" ADD CONSTRAINT "apps_gitInstallationId_fkey" FOREIGN KEY ("gitInstallationId") REFERENCES "github_installations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "apps" ADD CONSTRAINT "apps_passwordSecretId_fkey" FOREIGN KEY ("passwordSecretId") REFERENCES "secrets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "apps" ADD CONSTRAINT "apps_currentDeploymentId_fkey" FOREIGN KEY ("currentDeploymentId") REFERENCES "deployments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "apps" ADD CONSTRAINT "apps_primaryDomainId_fkey" FOREIGN KEY ("primaryDomainId") REFERENCES "domains"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "apps" ADD CONSTRAINT "apps_backupDestinationId_fkey" FOREIGN KEY ("backupDestinationId") REFERENCES "backup_destinations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "icon_images" ADD CONSTRAINT "icon_images_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "icon_images" ADD CONSTRAINT "icon_images_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "volumes" ADD CONSTRAINT "volumes_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domains" ADD CONSTRAINT "domains_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "env_vars" ADD CONSTRAINT "env_vars_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "secrets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "env_versions" ADD CONSTRAINT "env_versions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "env_versions" ADD CONSTRAINT "env_versions_snapshotSecretId_fkey" FOREIGN KEY ("snapshotSecretId") REFERENCES "secrets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_envSecretId_fkey" FOREIGN KEY ("envSecretId") REFERENCES "secrets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_previewId_fkey" FOREIGN KEY ("previewId") REFERENCES "preview_deployments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_log_chunks" ADD CONSTRAINT "deployment_log_chunks_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_envs" ADD CONSTRAINT "preview_envs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_envs" ADD CONSTRAINT "preview_envs_baseEnvironmentId_fkey" FOREIGN KEY ("baseEnvironmentId") REFERENCES "environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_deployments" ADD CONSTRAINT "preview_deployments_envId_fkey" FOREIGN KEY ("envId") REFERENCES "preview_envs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_deployments" ADD CONSTRAINT "preview_deployments_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_deployments" ADD CONSTRAINT "preview_deployments_currentDeploymentId_fkey" FOREIGN KEY ("currentDeploymentId") REFERENCES "deployments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_destinations" ADD CONSTRAINT "backup_destinations_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "integrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backups" ADD CONSTRAINT "backups_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backups" ADD CONSTRAINT "backups_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "backup_destinations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "alert_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_mutes" ADD CONSTRAINT "alert_mutes_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status_pages" ADD CONSTRAINT "status_pages_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status_page_items" ADD CONSTRAINT "status_page_items_statusPageId_fkey" FOREIGN KEY ("statusPageId") REFERENCES "status_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status_page_items" ADD CONSTRAINT "status_page_items_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status_incidents" ADD CONSTRAINT "status_incidents_statusPageId_fkey" FOREIGN KEY ("statusPageId") REFERENCES "status_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_uptime_days" ADD CONSTRAINT "app_uptime_days_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "terminal_tickets" ADD CONSTRAINT "terminal_tickets_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_samples" ADD CONSTRAINT "metric_samples_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runtime_log_lines" ADD CONSTRAINT "runtime_log_lines_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Invariants Prisma cannot express. CHECK constraints are not introspected, so they never show up
-- as drift in `prisma migrate diff`.
ALTER TABLE "instance" ADD CONSTRAINT "instance_singleton" CHECK ("id" = 1);
ALTER TABLE "apps" ADD CONSTRAINT "apps_one_source" CHECK (NOT ("image" IS NOT NULL AND "gitRepository" IS NOT NULL));
ALTER TABLE "apps" ADD CONSTRAINT "apps_port_range" CHECK ("port" IS NULL OR ("port" BETWEEN 1 AND 65535));
ALTER TABLE "apps" ADD CONSTRAINT "apps_replicas_range" CHECK ("replicas" BETWEEN 0 AND 20);
ALTER TABLE "apps" ADD CONSTRAINT "apps_retention_min" CHECK ("backupRetentionDays" >= 1);
ALTER TABLE "apps" ADD CONSTRAINT "apps_sysctls_object" CHECK (jsonb_typeof("sysctls") = 'object');
ALTER TABLE "apps" ADD CONSTRAINT "apps_root_dir_relative" CHECK ("rootDir" IS NULL OR ("rootDir" NOT LIKE '/%' AND "rootDir" NOT LIKE '%..%'));
ALTER TABLE "apps" ADD CONSTRAINT "apps_vercel_target" CHECK ("deployTarget" <> 'vercel' OR "vercelProjectId" IS NOT NULL);
ALTER TABLE "volumes" ADD CONSTRAINT "volumes_mount_absolute" CHECK ("mountPath" LIKE '/%');
ALTER TABLE "backup_destinations" ADD CONSTRAINT "backup_destinations_s3_has_storage" CHECK (("type" = 's3') = ("integrationId" IS NOT NULL));
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_attempts_range" CHECK ("attempts" >= 0 AND "maxAttempts" >= 1);
ALTER TABLE "apps" ADD CONSTRAINT "apps_builder_known" CHECK ("builder" IN ('auto', 'dockerfile'));
ALTER TABLE "projects" ADD CONSTRAINT "projects_preview_caps" CHECK ("previewMaxConcurrent" BETWEEN 1 AND 20 AND "previewIdleMinutes" BETWEEN 0 AND 1440 AND "previewTtlHours" BETWEEN 1 AND 720);
ALTER TABLE "projects" ADD CONSTRAINT "projects_preview_limits" CHECK ("previewCpuLimit" > 0 AND "previewCpuLimit" <= 8 AND "previewMemoryMb" BETWEEN 64 AND 16384 AND "previewPidsLimit" BETWEEN 16 AND 4096);
ALTER TABLE "instance" ADD CONSTRAINT "instance_preview_server_max" CHECK ("previewServerMax" BETWEEN 1 AND 50);
ALTER TABLE "preview_envs" ADD CONSTRAINT "preview_envs_pr_positive" CHECK ("prNumber" >= 1);
ALTER TABLE "release_updates" ADD CONSTRAINT "release_updates_rollback_of_check" CHECK (("kind" = 'rollback') = ("rollbackOfId" IS NOT NULL));
ALTER TABLE "release_updates" ADD CONSTRAINT "release_updates_attempt_check" CHECK ("attempt" >= 1);
ALTER TABLE "icon_images" ADD CONSTRAINT "icon_images_one_owner" CHECK (("appId" IS NULL) <> ("projectId" IS NULL));
ALTER TABLE "icon_images" ADD CONSTRAINT "icon_images_size_cap" CHECK (octet_length("data") BETWEEN 1 AND 131072 AND "width" BETWEEN 1 AND 4096 AND "height" BETWEEN 1 AND 4096);
ALTER TABLE "icon_images" ADD CONSTRAINT "icon_images_mime_known" CHECK ("mime" IN ('image/png', 'image/jpeg', 'image/webp', 'image/x-icon'));
