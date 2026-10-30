"""Eden-owned configuration for the vendored MIT VideoContext engine."""
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True

# This directory is copied with the Server artifact. Workers import the installed
# package from the private Python distribution prepared by the setup script.
sys.path.insert(0, str(Path(__file__).parent / "src"))
from video_understanding_mcp.config import Settings
from video_understanding_mcp.server import serve_stdio


def main():
    runtime = Path(sys.argv[1]).resolve(strict=True)
    scope = Path(sys.argv[2]).resolve(strict=True)
    manifest = json.loads((runtime / "runtime.json").read_text(encoding="utf-8"))
    settings = Settings(
        allowed_directories=(scope / "input",),
        cache_dir=scope / "jobs",
        model_cache_dir=runtime / "models",
        ffmpeg_path=(runtime / manifest["ffmpeg"]).resolve(strict=True),
        ffprobe_path=(runtime / manifest["ffprobe"]).resolve(strict=True),
        python_path=Path(sys.executable),
        default_whisper_model=manifest["model"],
        max_frame_retrieval_bytes=5 * 1024 * 1024,
        max_preview_retrieval_bytes=5 * 1024 * 1024,
        max_preview_retrieval=8,
        max_job_wall_seconds=110,
        subprocess_timeout_seconds=100,
        max_subprocess_cpu_seconds=110,
        max_source_bytes=512 * 1024 * 1024,
        max_output_frames=300,
        max_cache_bytes=2 * 1024**3,
        max_completed_output_bytes=256 * 1024 * 1024,
        min_free_bytes=256 * 1024 * 1024,
    )
    serve_stdio(settings)


if __name__ == "__main__":
    main()
