-- CreateEnum
CREATE TYPE "SignatureRequestStatus" AS ENUM ('DRAFT', 'SENT', 'DELIVERED', 'VIEWED', 'IN_REVIEW', 'PARTIALLY_SIGNED', 'PENDING', 'COMPLETED', 'REJECTED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SignerStatus" AS ENUM ('WAITING', 'SENT', 'DELIVERED', 'VIEWED', 'IN_REVIEW', 'SIGNED', 'REJECTED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SignerRole" AS ENUM ('SIGNER', 'APPROVER', 'CC');

-- CreateEnum
CREATE TYPE "SigningOrder" AS ENUM ('SEQUENTIAL', 'PARALLEL');

-- CreateEnum
CREATE TYPE "SignatureFieldType" AS ENUM ('SIGNATURE', 'INITIALS', 'DATE', 'NAME', 'TEXT');

-- CreateEnum
CREATE TYPE "SignatureMethod" AS ENUM ('DRAWN', 'UPLOADED', 'TYPED');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('INVITATION', 'REMINDER', 'OTP', 'VIEWED', 'PARTIALLY_SIGNED', 'COMPLETED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'DELIVERY_FAILED');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "VerificationChannel" AS ENUM ('EMAIL', 'SMS');

-- CreateEnum
CREATE TYPE "VerificationOutcome" AS ENUM ('PENDING', 'VERIFIED', 'FAILED', 'EXPIRED', 'LOCKED');

-- AlterEnum
ALTER TYPE "EmailProviderChoice" ADD VALUE IF NOT EXISTS 'SMTP';

-- AlterEnum
ALTER TYPE "EmailProviderType" ADD VALUE IF NOT EXISTS 'SMTP';

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "original_name" TEXT NOT NULL,
    "original_mime" TEXT NOT NULL,
    "original_size" INTEGER NOT NULL,
    "original_sha256" TEXT NOT NULL,
    "original_key" TEXT NOT NULL,
    "pdf_size" INTEGER NOT NULL,
    "pdf_sha256" TEXT NOT NULL,
    "pdf_key" TEXT NOT NULL,
    "page_count" INTEGER NOT NULL,
    "converted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_requests" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "document_version_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "message" TEXT,
    "status" "SignatureRequestStatus" NOT NULL DEFAULT 'DRAFT',
    "signing_order" "SigningOrder" NOT NULL DEFAULT 'SEQUENTIAL',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "reminder_every_days" INTEGER NOT NULL DEFAULT 2,
    "sender_name" TEXT NOT NULL,
    "sender_email" TEXT NOT NULL,
    "sender_company" TEXT,
    "document_sha256" TEXT,
    "final_key" TEXT,
    "final_sha256" TEXT,
    "final_size" INTEGER,
    "signature_level" TEXT NOT NULL DEFAULT 'electronic',
    "finalize_error" TEXT,
    "finalize_attempts" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "rejected_at" TIMESTAMP(3),
    "expired_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signature_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_recipients" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "SignerRole" NOT NULL DEFAULT 'SIGNER',
    "routing_order" INTEGER NOT NULL DEFAULT 1,
    "status" "SignerStatus" NOT NULL DEFAULT 'WAITING',
    "phone" TEXT,
    "require_sms_otp" BOOLEAN NOT NULL DEFAULT false,
    "token_hash" TEXT,
    "token_enc" TEXT,
    "token_revoked_at" TIMESTAMP(3),
    "signing_session_hash" TEXT,
    "signing_session_until" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "viewed_at" TIMESTAMP(3),
    "reviewed_at" TIMESTAMP(3),
    "consent_at" TIMESTAMP(3),
    "consent_text" TEXT,
    "consent_ip" TEXT,
    "consent_user_agent" TEXT,
    "email_verified_at" TIMESTAMP(3),
    "sms_verified_at" TIMESTAMP(3),
    "signed_at" TIMESTAMP(3),
    "rejected_at" TIMESTAMP(3),
    "reject_reason" TEXT,
    "last_reminder_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signature_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_fields" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "type" "SignatureFieldType" NOT NULL,
    "page" INTEGER NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "width" DOUBLE PRECISION NOT NULL,
    "height" DOUBLE PRECISION NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "label" TEXT,
    "value" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signature_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signatures" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "method" "SignatureMethod" NOT NULL,
    "image" BYTEA NOT NULL,
    "typed_name" TEXT,
    "font_style" TEXT,
    "signer_name" TEXT NOT NULL,
    "signer_email" TEXT NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "document_sha256" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signatures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_events" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "recipient_id" TEXT,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signature_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "user_id" TEXT,
    "request_id" TEXT,
    "document_id" TEXT,
    "recipient_id" TEXT,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "details" JSONB,
    "prev_hash" TEXT,
    "hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_notifications" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "recipient_id" TEXT,
    "kind" "NotificationKind" NOT NULL,
    "to_email" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "provider_message_id" TEXT,
    "next_attempt_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_attempts" (
    "id" TEXT NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "channel" "VerificationChannel" NOT NULL,
    "code_hash" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "outcome" "VerificationOutcome" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "verified_at" TIMESTAMP(3),
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "completion_certificates" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "original_sha256" TEXT NOT NULL,
    "final_sha256" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "completion_certificates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "documents_user_id_created_at_idx" ON "documents"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_document_id_version_key" ON "document_versions"("document_id", "version");

-- CreateIndex
CREATE INDEX "signature_requests_user_id_created_at_idx" ON "signature_requests"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "signature_requests_status_expires_at_idx" ON "signature_requests"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "signature_recipients_token_hash_key" ON "signature_recipients"("token_hash");

-- CreateIndex
CREATE INDEX "signature_recipients_request_id_routing_order_idx" ON "signature_recipients"("request_id", "routing_order");

-- CreateIndex
CREATE UNIQUE INDEX "signature_recipients_request_id_email_key" ON "signature_recipients"("request_id", "email");

-- CreateIndex
CREATE INDEX "signature_fields_request_id_page_idx" ON "signature_fields"("request_id", "page");

-- CreateIndex
CREATE UNIQUE INDEX "signatures_recipient_id_key" ON "signatures"("recipient_id");

-- CreateIndex
CREATE INDEX "signatures_request_id_idx" ON "signatures"("request_id");

-- CreateIndex
CREATE INDEX "signature_events_request_id_created_at_idx" ON "signature_events"("request_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_request_id_seq_idx" ON "audit_logs"("request_id", "seq");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_created_at_idx" ON "audit_logs"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_seq_key" ON "audit_logs"("seq");

-- CreateIndex
CREATE INDEX "email_notifications_status_next_attempt_at_idx" ON "email_notifications"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "email_notifications_request_id_created_at_idx" ON "email_notifications"("request_id", "created_at");

-- CreateIndex
CREATE INDEX "verification_attempts_recipient_id_created_at_idx" ON "verification_attempts"("recipient_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "completion_certificates_request_id_key" ON "completion_certificates"("request_id");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_document_version_id_fkey" FOREIGN KEY ("document_version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_recipients" ADD CONSTRAINT "signature_recipients_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "signature_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_fields" ADD CONSTRAINT "signature_fields_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "signature_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_fields" ADD CONSTRAINT "signature_fields_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "signature_recipients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "signature_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "signature_recipients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_events" ADD CONSTRAINT "signature_events_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "signature_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "signature_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_notifications" ADD CONSTRAINT "email_notifications_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "signature_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_notifications" ADD CONSTRAINT "email_notifications_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "signature_recipients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_attempts" ADD CONSTRAINT "verification_attempts_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "signature_recipients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "completion_certificates" ADD CONSTRAINT "completion_certificates_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "signature_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Append-only audit trail: rows can be added, never changed or removed.
CREATE OR REPLACE FUNCTION esign_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION esign_append_only();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON "audit_logs" FOR EACH STATEMENT EXECUTE FUNCTION esign_append_only();
CREATE TRIGGER signature_events_append_only BEFORE UPDATE OR DELETE ON "signature_events" FOR EACH ROW EXECUTE FUNCTION esign_append_only();
CREATE TRIGGER signature_events_no_truncate BEFORE TRUNCATE ON "signature_events" FOR EACH STATEMENT EXECUTE FUNCTION esign_append_only();
