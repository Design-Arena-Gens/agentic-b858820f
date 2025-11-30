'use client';

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Worker } from "tesseract.js";
import { parseMRZ } from "../lib/mrz";
import { extractFields, DocumentExtraction } from "../lib/extraction";
import {
  ApplicantProfile,
  defaultPolicy,
  evaluateEligibility,
  parsePolicy,
} from "../lib/policy";
import { buildReport, StructuredReport, ApplicantCheck } from "../lib/report";
import { computeNameSimilarity } from "../lib/utils";

type UploadedDocument = {
  id: string;
  file: File;
  name: string;
  size: number;
  status: "pending" | "processing" | "done" | "error";
  text?: string;
  extraction?: DocumentExtraction;
  error?: string;
};

type ToastMessage = {
  title: string;
  description: string;
};

const defaultPolicyText = JSON.stringify(defaultPolicy, null, 2);

export default function Home() {
  const [documents, setDocuments] = useState<UploadedDocument[]>([]);
  const [policyText, setPolicyText] = useState<string>(defaultPolicyText);
  const [processing, setProcessing] = useState<boolean>(false);
  const [ocrProgress, setOcrProgress] = useState<number>(0);
  const [report, setReport] = useState<StructuredReport | null>(null);
  const [viewMode, setViewMode] = useState<"summary" | "json">("summary");
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const [applicantForm, setApplicantForm] = useState({
    surname: "",
    givenNames: "",
    dateOfBirth: "",
    nationality: "",
    passportNumber: "",
    visaType: "tourist",
  });

  useEffect(() => {
    return () => {
      if (workerRef.current) {
        void workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, []);

  const ensureWorker = async (): Promise<Worker> => {
    if (workerRef.current) return workerRef.current;
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker({
      logger: (message) => {
        if (message.status === "recognizing text" && message.progress) {
          setOcrProgress(Math.round(message.progress * 100));
        }
      },
    });
    await worker.load();
    await worker.loadLanguage("eng");
    await worker.initialize("eng");
    workerRef.current = worker;
    return worker;
  };

  const handleFiles = (files: FileList | File[]) => {
    const array = Array.from(files);
    const nextDocs = array.map<UploadedDocument>((file) => ({
      id: crypto.randomUUID(),
      file,
      name: file.name,
      size: file.size,
      status: "pending",
    }));
    setDocuments((prev) => [...prev, ...nextDocs]);
    setToast({
      title: "Files Added",
      description: `${nextDocs.length} document(s) queued for analysis.`,
    });
  };

  const removeDocument = (id: string) => {
    setDocuments((prev) => prev.filter((doc) => doc.id !== id));
  };

  const runAnalysis = async () => {
    if (documents.length === 0) {
      setToast({
        title: "No Documents",
        description: "Add at least one document image before analysis.",
      });
      return;
    }
    setProcessing(true);
    setOcrProgress(0);
    setReport(null);

    try {
      const worker = await ensureWorker();
      const existingExtractions = documents
        .filter((doc) => doc.status === "done" && doc.extraction)
        .map((doc) => doc.extraction as DocumentExtraction);
      const collectedExtractions: DocumentExtraction[] = [...existingExtractions];

      for (const doc of documents) {
        setDocuments((prev) =>
          prev.map((current) =>
            current.id === doc.id
              ? { ...current, status: "processing", error: undefined }
              : current
          )
        );
        try {
          const result = await worker.recognize(doc.file);
          const rawText = result.data.text;
          const mrz = parseMRZ(rawText);
          const extraction = extractFields(rawText, mrz);
          collectedExtractions.push(extraction);
          setDocuments((prev) =>
            prev.map((current) =>
              current.id === doc.id
                ? {
                    ...current,
                    status: "done",
                    text: rawText,
                    extraction,
                  }
                : current
            )
          );
        } catch (error) {
          setDocuments((prev) =>
            prev.map((current) =>
              current.id === doc.id
                ? {
                    ...current,
                    status: "error",
                    error:
                      error instanceof Error
                        ? error.message
                        : "OCR failed unexpectedly.",
                  }
                : current
            )
          );
        }
      }

      const processedDocs = collectedExtractions;

      if (processedDocs.length === 0) {
        setToast({
          title: "Analysis Incomplete",
          description: "OCR failed for all documents. Check image quality.",
        });
        setProcessing(false);
        return;
      }

      let policy;
      try {
        policy = parsePolicy(policyText);
      } catch (error) {
        setToast({
          title: "Policy Error",
          description: "Invalid policy JSON. Reverting to default policy.",
        });
        policy = defaultPolicy;
      }

      const applicant: ApplicantProfile = {
        surname: applicantForm.surname,
        givenNames: applicantForm.givenNames,
        fullName: `${applicantForm.givenNames} ${applicantForm.surname}`.trim(),
        dateOfBirth: applicantForm.dateOfBirth,
        nationality: applicantForm.nationality,
        passportNumber: applicantForm.passportNumber,
        visaType: applicantForm.visaType,
      };

      const eligibility = evaluateEligibility(
        applicant,
        processedDocs,
        policy
      );

      const crossChecks: ApplicantCheck[] = [];

      const bestDoc = processedDocs.reduce((acc, current) =>
        current.confidence > acc.confidence ? current : acc
      );
      const docName = `${bestDoc.fields.givenNames?.value ?? ""} ${
        bestDoc.fields.surname?.value ?? ""
      }`.trim();
      if (docName) {
        const similarity = computeNameSimilarity(
          docName,
          applicant.fullName
        );
        crossChecks.push({
          field: "fullName",
          status:
            similarity > 0.75
              ? "pass"
              : similarity > 0.4
              ? "warning"
              : "fail",
          detail: `Document vs applicant name similarity ${(similarity * 100).toFixed(1)}%.`,
          confidence: Math.round(similarity * 100),
        });
      }

      const docDob = bestDoc.fields.birthDate?.value;
      if (docDob && applicant.dateOfBirth) {
        const match = docDob === applicant.dateOfBirth;
        crossChecks.push({
          field: "dateOfBirth",
          status: match ? "pass" : "warning",
          detail: match
            ? "Date of birth matches applicant input."
            : `DOB mismatch: document ${docDob}, applicant ${applicant.dateOfBirth}.`,
          confidence: bestDoc.fields.birthDate?.confidence ?? 60,
        });
      }

      const docPassport = bestDoc.fields.documentNumber?.value;
      if (docPassport && applicant.passportNumber) {
        const normalizedDoc = docPassport.replace(/\s+/g, "").toUpperCase();
        const normalizedApplicant = applicant.passportNumber
          .replace(/\s+/g, "")
          .toUpperCase();
        const match = normalizedDoc === normalizedApplicant;
        crossChecks.push({
          field: "passportNumber",
          status: match ? "pass" : "warning",
          detail: match
            ? "Passport number aligns."
            : `Passport mismatch: document ${normalizedDoc}, applicant ${normalizedApplicant}.`,
          confidence: bestDoc.fields.documentNumber?.confidence ?? 60,
        });
      }

      if (bestDoc.fields.nationality?.value && applicant.nationality) {
        const docNationality = bestDoc.fields.nationality.value
          .replace(/[^A-Z]/gi, "")
          .toUpperCase();
        const applicantNationality = applicant.nationality
          .replace(/[^A-Z]/gi, "")
          .toUpperCase();
        const match = docNationality === applicantNationality;
        crossChecks.push({
          field: "nationality",
          status: match ? "pass" : "warning",
          detail: match
            ? "Nationality consistent."
            : `Nationality difference: document ${docNationality}, applicant ${applicantNationality}.`,
          confidence: bestDoc.fields.nationality?.confidence ?? 60,
        });
      }

      const structuredReport = buildReport(
        processedDocs,
        eligibility,
        applicant,
        crossChecks
      );
      setReport(structuredReport);
      setToast({
        title: "Analysis Complete",
        description: "Structured verification report generated.",
      });
    } finally {
      setProcessing(false);
      setOcrProgress(0);
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
      handleFiles(event.dataTransfer.files);
      event.dataTransfer.clearData();
    }
  };

  const jsonResult = useMemo(() => {
    if (!report) return "";
    return JSON.stringify(report, null, 2);
  }, [report]);

  const copyJson = async () => {
    if (!jsonResult) return;
    await navigator.clipboard.writeText(jsonResult);
    setToast({
      title: "Copied",
      description: "JSON report copied to clipboard.",
    });
  };

  return (
    <div className="app-shell">
      <div className="main-card">
        <header className="header">
          <div>
            <h1 className="title">Atlas Verify · Document Intelligence</h1>
            <p className="subtitle">
              Upload travel documents, run OCR + MRZ extraction, and assess visa eligibility in one pass.
            </p>
          </div>
          <div className="badge success">
            <span>OCR Ready</span>
          </div>
        </header>

        <div className="grid">
          <section className="panel">
            <h2>1 · Applicant Profile</h2>
            <p>Provide declared applicant details for cross-checking and eligibility scoring.</p>
            <div className="form-grid">
              <div className="input-group">
                <label>Surname</label>
                <input
                  value={applicantForm.surname}
                  onChange={(event) =>
                    setApplicantForm((prev) => ({
                      ...prev,
                      surname: event.target.value,
                    }))
                  }
                  placeholder="DOE"
                />
              </div>
              <div className="input-group">
                <label>Given Names</label>
                <input
                  value={applicantForm.givenNames}
                  onChange={(event) =>
                    setApplicantForm((prev) => ({
                      ...prev,
                      givenNames: event.target.value,
                    }))
                  }
                  placeholder="JANE MARIE"
                />
              </div>
              <div className="input-group">
                <label>Date of Birth</label>
                <input
                  type="date"
                  value={applicantForm.dateOfBirth}
                  onChange={(event) =>
                    setApplicantForm((prev) => ({
                      ...prev,
                      dateOfBirth: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="input-group">
                <label>Nationality (ICAO Alpha-3)</label>
                <input
                  value={applicantForm.nationality}
                  onChange={(event) =>
                    setApplicantForm((prev) => ({
                      ...prev,
                      nationality: event.target.value.toUpperCase(),
                    }))
                  }
                  placeholder="USA"
                />
              </div>
              <div className="input-group">
                <label>Passport Number</label>
                <input
                  value={applicantForm.passportNumber}
                  onChange={(event) =>
                    setApplicantForm((prev) => ({
                      ...prev,
                      passportNumber: event.target.value.toUpperCase(),
                    }))
                  }
                  placeholder="123456789"
                />
              </div>
              <div className="input-group">
                <label>Intended Visa Type</label>
                <select
                  value={applicantForm.visaType}
                  onChange={(event) =>
                    setApplicantForm((prev) => ({
                      ...prev,
                      visaType: event.target.value,
                    }))
                  }
                >
                  <option value="tourist">Tourist</option>
                  <option value="business">Business</option>
                  <option value="student">Student</option>
                </select>
              </div>
            </div>
          </section>

          <section className="panel">
            <h2>2 · Document Intake</h2>
            <p>Drag & drop high-resolution scans or photos. Supports JPEG, PNG, WEBP.</p>
            <label
              className="dropzone"
              onDragOver={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onDrop={handleDrop}
            >
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={(event) => {
                  if (event.target.files) {
                    handleFiles(event.target.files);
                  }
                }}
              />
              <strong>Drop files or click to browse</strong>
              <div style={{ marginTop: "8px", fontSize: "0.85rem" }}>
                {processing ? `OCR progress ${ocrProgress}%` : "Supports multi-page batch analysis."}
              </div>
            </label>
            <div className="mini-grid">
              {documents.map((doc) => (
                <div
                  key={doc.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "10px 12px",
                    borderRadius: "12px",
                    border: "1px solid rgba(148,163,184,0.2)",
                    background: "rgba(15,23,42,0.4)",
                    gap: "12px",
                  }}
                >
                  <div>
                    <strong>{doc.name}</strong>
                    <div style={{ fontSize: "0.8rem", color: "#94a3b8" }}>
                      {(doc.size / 1024).toFixed(1)} KB · Status: {doc.status}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    {doc.status === "error" && (
                      <span className="badge error">OCR error</span>
                    )}
                    <button
                      type="button"
                      style={{
                        border: "none",
                        background: "rgba(239,68,68,0.15)",
                        color: "#f87171",
                        padding: "8px 12px",
                        borderRadius: "10px",
                        cursor: "pointer",
                      }}
                      onClick={() => removeDocument(doc.id)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
              {documents.length === 0 && (
                <div style={{ fontSize: "0.85rem", color: "#94a3b8" }}>
                  No documents queued. Add at least one passport, ID, or visa page.
                </div>
              )}
            </div>
            <button
              className="btn"
              onClick={runAnalysis}
              disabled={processing}
            >
              {processing ? "Analyzing..." : "Analyze & Verify"}
            </button>
          </section>
        </div>

        <section className="panel" style={{ marginTop: "20px" }}>
          <h2>3 · Eligibility Policy</h2>
          <p>Adjust policy thresholds per visa type. Invalid JSON falls back to the default policy.</p>
          <textarea
            value={policyText}
            onChange={(event) => setPolicyText(event.target.value)}
          />
        </section>

        <section className="panel" style={{ marginTop: "20px" }}>
          <div className="flex-between">
            <h2>4 · Verification Output</h2>
            <div className="switcher">
              <button
                type="button"
                className={viewMode === "summary" ? "active" : ""}
                onClick={() => setViewMode("summary")}
              >
                Summary
              </button>
              <button
                type="button"
                className={viewMode === "json" ? "active" : ""}
                onClick={() => setViewMode("json")}
              >
                JSON
              </button>
              <button type="button" onClick={copyJson} disabled={!jsonResult}>
                Copy JSON
              </button>
            </div>
          </div>
          <div className="results-card">
            {report ? (
              viewMode === "summary" ? (
                <div className="json-output">
                  <strong>Summary:</strong> {report.summary}
                  <br />
                  <strong>Status:</strong> {report.overallStatus} |{" "}
                  <strong>Confidence:</strong> {report.overallConfidence}%
                  <br />
                  <strong>Next Actions:</strong>{" "}
                  {report.nextActions.join(" · ")}
                </div>
              ) : (
                <pre className="json-output">{jsonResult}</pre>
              )
            ) : (
              <div style={{ color: "#94a3b8", fontSize: "0.85rem" }}>
                Run analysis to generate a structured JSON report with confidence scores and next actions.
              </div>
            )}
          </div>
        </section>

        {toast && (
          <div className="toast">
            <strong>{toast.title}</strong>
            <span>{toast.description}</span>
          </div>
        )}
      </div>
    </div>
  );
}
