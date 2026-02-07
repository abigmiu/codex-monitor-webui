import { useEffect, useState } from "react";
import { openExternalUrl } from "../../../platform/opener";

const GITHUB_URL = "https://github.com/Dimillian/CodexMonitor";
const TWITTER_URL = "https://x.com/dimillian";

export function AboutView() {
  const [version, setVersion] = useState<string | null>(null);

  const handleOpenGitHub = () => {
    void openExternalUrl(GITHUB_URL);
  };

  const handleOpenTwitter = () => {
    void openExternalUrl(TWITTER_URL);
  };

  useEffect(() => {
    setVersion(__APP_VERSION__ || null);
  }, []);

  return (
    <div className="about">
      <div className="about-card">
        <div className="about-header">
          <img
            className="about-icon"
            src="/app-icon.png"
            alt="Codex Monitor icon"
          />
          <div className="about-title">Codex Monitor</div>
        </div>
        <div className="about-version">
          {version ? `Version ${version}` : "Version —"}
        </div>
        <div className="about-tagline">
          Monitor the situation of your Codex agents
        </div>
        <div className="about-divider" />
        <div className="about-links">
          <button
            type="button"
            className="about-link"
            onClick={handleOpenGitHub}
          >
            GitHub
          </button>
          <span className="about-link-sep">|</span>
          <button
            type="button"
            className="about-link"
            onClick={handleOpenTwitter}
          >
            Twitter
          </button>
        </div>
        <div className="about-footer">Made with ♥ by Codex & Dimillian</div>
      </div>
    </div>
  );
}
