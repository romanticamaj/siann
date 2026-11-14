#pragma once

// Jobs v0 (architecture spec, "Commands and jobs", Jobs v0): in-memory jobs
// run one at a time in creation order, on one worker thread (the
// offline-render thread) or, without it, by runQueued() on the caller's
// thread. A render job renders an immutable document snapshot offline and
// writes <bundle>/renders/<name>.wav atomically. A peaks job (Protocol v0
// item 23) computes one media file's peak pyramid and writes
// <bundle>/peaks/<hex>.peaks atomically. Jobs are not journaled; render and
// peaks jobs change nothing in the document. An import job (Jobs v0, import)
// writes its media and peaks on the worker, then waits, still running, until the
// command thread has committed media.add (takeFinishedImports, completeImport).

#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <utility>

#include <memory>
#include <vector>

#include <functional>

#include "siann/engine/offline.hpp"
#include "siann/hash/json.hpp"
#include "siann/hash/sha256.hpp"
#include "siann/model/document.hpp"
#include "siann/session/media_import.hpp"

namespace siann::protocol::detail {

enum class JobState { queued, running, done, failed };

struct RenderRequest {
    std::string name;  // already checked: no path
    std::int64_t start = 0;
    std::int64_t frames = -1;  // -1: to the end of the document
    model::Document document;
    std::filesystem::path bundle;
    // The render's own plugin instances (Jobs v0, plugins); nullptr: every slot
    // passes through. Handed back to the command thread when the job ends.
    std::shared_ptr<engine::PluginNodeSource> plugins;
};

// One media file's peak pyramid (Protocol v0 item 23).
struct PeaksRequest {
    std::filesystem::path bundle;
    hash::Digest contentHash{};
    model::MediaFormat format = model::MediaFormat::wav;
};

// media.import (Jobs v0, import): the worker prepares (decodes, converts, writes
// media and peaks); the command thread commits media.add and only then reports
// the job done.
struct ImportRequest {
    std::filesystem::path bundle;
    std::int64_t sessionRate = 0;
    std::filesystem::path path;
    // Opens the file; empty: session::openImportSource (tests pass a paced source).
    std::function<session::ImportSource(const std::filesystem::path&)> open;
    // The session the job imports into, compared by address on the command thread.
    const void* owner = nullptr;
};

// An import whose files are written, waiting for the command thread's commit.
struct FinishedImport {
    std::string jobId;
    const void* owner = nullptr;
    session::PreparedImport prepared;
};

class JobRunner {
public:
    // `wake` runs (on the worker, outside the lock) when an import is ready for
    // its commit, so a waiting command thread picks it up at once.
    explicit JobRunner(bool workerThread, std::function<void()> wake = {});
    ~JobRunner();
    JobRunner(const JobRunner&) = delete;
    JobRunner& operator=(const JobRunner&) = delete;

    // Queues a render and returns its id ("job_<n>").
    std::string startRender(RenderRequest request);
    // Queues a peak pyramid computation and returns its id.
    std::string startPeaks(PeaksRequest request);
    // Queues an import and returns its id.
    std::string startImport(ImportRequest request);
    // The imports prepared since the last call, still `running`, for the command
    // thread to commit (or discard). Each is then completed or failed below.
    std::vector<FinishedImport> takeFinishedImports();
    void completeImport(const std::string& jobId, json::Value result);
    void failImport(const std::string& jobId, std::string code, std::string message);
    // Cancels every import: queued ones and prepared ones awaiting their commit end
    // failed (cancelled) at once, their files removed; a running one is
    // interrupted and ends so at its next block.
    void cancelImports();
    // A job that ran inside its request on the command thread (plugin.instantiate):
    // recorded done or failed, so job.status answers it. Returns its id.
    std::string recordDone(std::string kind, json::Value result);
    std::string recordFailed(std::string kind, std::string code, std::string message);
    // The plugin instance sets of the render jobs that ended since the last call,
    // for the command thread to destroy.
    std::vector<std::shared_ptr<engine::PluginNodeSource>> takeFinishedPlugins();
    // {jobId, kind, state, result?, error?}, or nullopt for an unknown id.
    std::optional<json::Value> status(const std::string& jobId) const;
    // The job's state; nullopt for an unknown id.
    std::optional<JobState> state(const std::string& jobId) const;
    // {code, message} of a failed job; nullopt for any other.
    std::optional<std::pair<std::string, std::string>> failure(const std::string& jobId) const;
    // Runs every queued job on the calling thread; returns how many ran.
    std::size_t runQueued();
    // Waits until the job is done or failed; false on timeout or unknown id.
    bool wait(const std::string& jobId, std::chrono::milliseconds timeout);
    // Stops and joins the worker; queued jobs stay queued.
    void stop();

private:
    struct Job {
        std::string id;
        std::string kind = "render";
        JobState state = JobState::queued;
        std::optional<RenderRequest> request;  // until it runs (kind render)
        std::optional<PeaksRequest> peaks;     // until it runs (kind peaks)
        std::optional<ImportRequest> import;   // until it runs (kind media.import)
        std::shared_ptr<session::ImportProgress> progress;  // kind media.import
        media::AudioSource* liveSource = nullptr;  // while the worker reads it
        json::Value result;
        std::string errorCode;
        std::string errorMessage;
    };

    // Runs the oldest queued job; false when none is queued.
    bool runOne(std::unique_lock<std::mutex>& lock);
    // The worker's part of an import; the lock is released while it reads.
    void runImport(std::unique_lock<std::mutex>& lock, Job& job, ImportRequest request);
    void fail(Job& job, std::string code, std::string message);
    void work();

    mutable std::mutex mutex_;
    std::condition_variable changed_;
    std::map<std::string, Job> jobs_;
    std::deque<std::string> queue_;
    std::vector<std::shared_ptr<engine::PluginNodeSource>> finishedPlugins_;
    std::vector<FinishedImport> finishedImports_;
    std::function<void()> wake_;
    std::uint64_t next_ = 1;
    bool stopping_ = false;
    std::thread worker_;
};

}  // namespace siann::protocol::detail
