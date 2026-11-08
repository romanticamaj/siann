#pragma once

// Jobs v0 (architecture spec, "Commands and jobs", Jobs v0): in-memory jobs
// run one at a time in creation order, on one worker thread (the
// offline-render thread) or, without it, by runQueued() on the caller's
// thread. A render job renders an immutable document snapshot offline and
// writes <bundle>/renders/<name>.wav atomically. Jobs are not journaled and
// change nothing in the document.

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

#include <memory>
#include <vector>

#include "siann/engine/offline.hpp"
#include "siann/hash/json.hpp"
#include "siann/model/document.hpp"

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

class JobRunner {
public:
    explicit JobRunner(bool workerThread);
    ~JobRunner();
    JobRunner(const JobRunner&) = delete;
    JobRunner& operator=(const JobRunner&) = delete;

    // Queues a render and returns its id ("job_<n>").
    std::string startRender(RenderRequest request);
    // A job that ran inside its request on the command thread (plugin.instantiate):
    // recorded done or failed, so job.status answers it. Returns its id.
    std::string recordDone(std::string kind, json::Value result);
    std::string recordFailed(std::string kind, std::string code, std::string message);
    // The plugin instance sets of the render jobs that ended since the last call,
    // for the command thread to destroy.
    std::vector<std::shared_ptr<engine::PluginNodeSource>> takeFinishedPlugins();
    // {jobId, kind, state, result?, error?}, or nullopt for an unknown id.
    std::optional<json::Value> status(const std::string& jobId) const;
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
        std::optional<RenderRequest> request;  // until it runs
        json::Value result;
        std::string errorCode;
        std::string errorMessage;
    };

    // Runs the oldest queued job; false when none is queued.
    bool runOne(std::unique_lock<std::mutex>& lock);
    void work();

    mutable std::mutex mutex_;
    std::condition_variable changed_;
    std::map<std::string, Job> jobs_;
    std::deque<std::string> queue_;
    std::vector<std::shared_ptr<engine::PluginNodeSource>> finishedPlugins_;
    std::uint64_t next_ = 1;
    bool stopping_ = false;
    std::thread worker_;
};

}  // namespace siann::protocol::detail
