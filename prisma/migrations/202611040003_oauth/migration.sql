CREATE TABLE "OAuthAccount" (id UUID NOT NULL PRIMARY KEY, provider TEXT NOT NULL, subject TEXT NOT NULL, "userId" UUID NOT NULL REFERENCES "User"(id) ON DELETE CASCADE, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX "OAuthAccount_provider_subject_key" ON "OAuthAccount" (provider, subject);
