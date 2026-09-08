// Docker Engine API backend over stdlib net/http.
//
// No third-party docker client is vendored: the backend speaks the Engine
// REST API directly, over the default unix socket or DOCKER_HOST
// (unix:// or tcp://). This keeps the module dependency-free.
package backend

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

// defaultImage is the container image for wallet sandboxes.
const defaultImage = "docker.io/library/alpine:3.21"

// engineVersion pins the Engine API version negotiated with the daemon.
const engineVersion = "v1.47"

// DockerBackend is the real ContainerBackend against a Docker daemon.
type DockerBackend struct {
	client      *http.Client
	host        string
	networkMode string
	// version is the negotiated Engine API version, defaulting to
	// engineVersion until Ping downgrades it to the daemon max.
	version string
}

// NewDockerBackend builds a backend dialing dockerHost ("" selects the
// default socket). The optional networkMode (default "none") pins every
// wallet container's NetworkMode. The returned error is typed for startup
// fail-fast.
func NewDockerBackend(dockerHost string, networkMode ...string) (*DockerBackend, error) {
	scheme, addr, err := splitDockerHost(dockerHost)
	if err != nil {
		return nil, err
	}
	mode := "none"
	if len(networkMode) > 0 && networkMode[0] != "" {
		mode = networkMode[0]
	}
	transport := &http.Transport{DisableCompression: true}
	if scheme == "unix" {
		transport.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
			d := net.Dialer{Timeout: 5 * time.Second}
			return d.DialContext(ctx, "unix", addr)
		}
	}
	client := &http.Client{Transport: transport, Timeout: 60 * time.Second}
	return &DockerBackend{client: client, host: scheme + "://" + addr, networkMode: mode, version: engineVersion}, nil
}

// NetworkMode reports the pinned container network mode.
func (b *DockerBackend) NetworkMode() string { return b.networkMode }

// splitDockerHost normalizes "" to the default socket and accepts
// unix:// and tcp:// forms.
func splitDockerHost(raw string) (string, string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "unix", "/var/run/docker.sock", nil
	}
	if strings.HasPrefix(raw, "unix://") {
		path := strings.TrimPrefix(raw, "unix://")
		if path == "" {
			return "", "", fmt.Errorf("host %q: %w", raw, ErrDaemon)
		}
		return "unix", path, nil
	}
	if strings.HasPrefix(raw, "tcp://") {
		addr := strings.TrimPrefix(raw, "tcp://")
		if addr == "" {
			return "", "", fmt.Errorf("host %q: %w", raw, ErrDaemon)
		}
		return "tcp", addr, nil
	}
	return "", "", fmt.Errorf("host %q: %w", raw, ErrDaemon)
}

type apiError struct {
	Message string `json:"message"`
}

func (b *DockerBackend) do(ctx context.Context, method, path string, body []byte) (int, []byte, error) {
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	ver := b.version
	if ver == "" {
		ver = engineVersion
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://docker/"+ver+path, rdr)
	if err != nil {
		return 0, nil, fmt.Errorf("build request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := b.client.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("daemon call %s %s: %w", method, path, ErrDaemon)
	}
	defer func() {
		_ = resp.Body.Close()
	}()
	out, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return 0, nil, fmt.Errorf("read daemon body: %w", err)
	}
	return resp.StatusCode, out, nil
}

func daemonMessage(out []byte) string {
	var e apiError
	if err := json.Unmarshal(out, &e); err != nil {
		return strings.TrimSpace(string(out))
	}
	if e.Message == "" {
		return strings.TrimSpace(string(out))
	}
	return e.Message
}

// Ping checks daemon reachability via GET /_ping and negotiates the API
// version down when the daemon reports a max below engineVersion (e.g. older
// distro daemons). Without this the pinned version is rejected outright.
func (b *DockerBackend) Ping(ctx context.Context) error {
	status, out, err := b.do(ctx, http.MethodGet, "/_ping", nil)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("ping: %s: %w", daemonMessage(out), ErrDaemon)
	}
	if v, err := b.serverAPIVersion(ctx); err == nil && v != "" && apiOlder(v, b.version) {
		b.version = v
	}
	return nil
}

// serverAPIVersion reads the daemon max via the unversioned /version endpoint.
func (b *DockerBackend) serverAPIVersion(ctx context.Context) (string, error) {
	ver := b.version
	b.version = engineVersion
	defer func() { b.version = ver }()
	status, out, err := b.do(ctx, http.MethodGet, "/version", nil)
	if err != nil {
		return "", err
	}
	if status < 200 || status >= 300 {
		return "", fmt.Errorf("version: %s: %w", daemonMessage(out), ErrDaemon)
	}
	var v struct {
		APIVersion string `json:"ApiVersion"`
	}
	if err := json.Unmarshal(out, &v); err != nil || v.APIVersion == "" {
		return "", fmt.Errorf("decode version: %w", err)
	}
	return "v" + strings.TrimPrefix(strings.TrimSpace(v.APIVersion), "v"), nil
}

// apiOlder reports whether server (v1.NN) is older than client (v1.MM).
// Unparseable inputs fail safe: no downgrade.
func apiOlder(server, client string) bool {
	sn, ok1 := apiMinor(server)
	cn, ok2 := apiMinor(client)
	return ok1 && ok2 && sn < cn
}

func apiMinor(v string) (int, bool) {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	parts := strings.SplitN(v, ".", 3)
	if len(parts) < 2 {
		return 0, false
	}
	var major, minor int
	if _, err := fmt.Sscanf(parts[0], "%d", &major); err != nil {
		return 0, false
	}
	if _, err := fmt.Sscanf(parts[1], "%d", &minor); err != nil {
		return 0, false
	}
	_ = major
	return minor, true
}

// CreateContainer creates and starts a sleeping sandbox with CPU/memory caps.
// Re-allocate is idempotent: a same-named container is removed first.
func (b *DockerBackend) CreateContainer(ctx context.Context, name string, lim Limits) (string, error) {
	_, _, err := b.do(ctx, http.MethodDelete, "/containers/"+name+"?force=true", nil)
	if err != nil {
		return "", err
	}
	payload, err := json.Marshal(map[string]any{
		"Image": defaultImage,
		"Cmd":   []string{"sleep", "infinity"},
		"HostConfig": map[string]any{
			"Memory":      lim.MemMB * 1024 * 1024,
			"NanoCpus":    int64(lim.CPUCores * 1e9),
			"CapDrop":     []string{"ALL"},
			"PidsLimit":   64,
			"NetworkMode": b.networkMode,
		},
	})
	if err != nil {
		return "", fmt.Errorf("encode create: %w", err)
	}
	status, out, err := b.do(ctx, http.MethodPost, "/containers/create?name="+name, payload)
	if err != nil {
		return "", err
	}
	if status == http.StatusNotFound {
		if perr := b.pullImage(ctx); perr != nil {
			return "", fmt.Errorf("pull image: %w", perr)
		}
		status, out, err = b.do(ctx, http.MethodPost, "/containers/create?name="+name, payload)
		if err != nil {
			return "", err
		}
	}
	if status < 200 || status >= 300 {
		return "", fmt.Errorf("create %s: %s: %w", name, daemonMessage(out), ErrDaemon)
	}
	var created struct {
		ID string `json:"Id"`
	}
	if err := json.Unmarshal(out, &created); err != nil || created.ID == "" {
		return "", fmt.Errorf("decode create: %w", err)
	}
	status, out, err = b.do(ctx, http.MethodPost, "/containers/"+created.ID+"/start", nil)
	if err != nil {
		return "", err
	}
	if status < 200 || status >= 300 {
		return "", fmt.Errorf("start %s: %s: %w", created.ID, daemonMessage(out), ErrDaemon)
	}
	return created.ID, nil
}

func (b *DockerBackend) pullImage(ctx context.Context) error {
	status, out, err := b.do(ctx, http.MethodPost, "/images/create?fromImage="+defaultImage, nil)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("pull: %s: %w", daemonMessage(out), ErrDaemon)
	}
	return nil
}

// ExecCommand runs cmd in a container and demuxes the Engine stream.
func (b *DockerBackend) ExecCommand(ctx context.Context, containerID string, cmd []string) (ExecResult, error) {
	payload, err := json.Marshal(map[string]any{
		"AttachStdout": true,
		"AttachStderr": true,
		"Cmd":          cmd,
	})
	if err != nil {
		return ExecResult{}, fmt.Errorf("encode exec: %w", err)
	}
	status, out, err := b.do(ctx, http.MethodPost, "/containers/"+containerID+"/exec", payload)
	if err != nil {
		return ExecResult{}, err
	}
	if status == http.StatusNotFound {
		return ExecResult{}, fmt.Errorf("container %s: %w", containerID, ErrNoSuchContainer)
	}
	if status < 200 || status >= 300 {
		return ExecResult{}, fmt.Errorf("exec create: %s: %w", daemonMessage(out), ErrDaemon)
	}
	var created struct {
		ID string `json:"Id"`
	}
	if err := json.Unmarshal(out, &created); err != nil || created.ID == "" {
		return ExecResult{}, fmt.Errorf("decode exec: %w", err)
	}
	startPayload, err := json.Marshal(map[string]any{"Detach": false, "Tty": false})
	if err != nil {
		return ExecResult{}, fmt.Errorf("encode exec start: %w", err)
	}
	status, out, err = b.do(ctx, http.MethodPost, "/exec/"+created.ID+"/start", startPayload)
	if err != nil {
		return ExecResult{}, err
	}
	if status < 200 || status >= 300 {
		return ExecResult{}, fmt.Errorf("exec start: %s: %w", daemonMessage(out), ErrDaemon)
	}
	stdout, stderr := demux(out)
	status, out, err = b.do(ctx, http.MethodGet, "/exec/"+created.ID+"/json", nil)
	if err != nil {
		return ExecResult{}, err
	}
	code := 0
	if status >= 200 && status < 300 {
		var inspect struct {
			ExitCode *int `json:"ExitCode"`
		}
		if err := json.Unmarshal(out, &inspect); err == nil && inspect.ExitCode != nil {
			code = *inspect.ExitCode
		}
	}
	return ExecResult{Stdout: stdout, Stderr: stderr, ExitCode: code}, nil
}

// demux splits the Engine multiplexed stream into stdout/stderr strings.
func demux(frame []byte) (string, string) {
	var stdout, stderr strings.Builder
	for len(frame) >= 8 {
		stream := frame[0]
		size := int(binary.BigEndian.Uint32(frame[4:8]))
		frame = frame[8:]
		if size > len(frame) {
			size = len(frame)
		}
		switch stream {
		case 2:
			stderr.Write(frame[:size])
		default:
			stdout.Write(frame[:size])
		}
		frame = frame[size:]
	}
	return stdout.String(), stderr.String()
}

// KillContainer force-kills a container; missing containers are nil (idempotent).
func (b *DockerBackend) KillContainer(ctx context.Context, containerID string) error {
	status, out, err := b.do(ctx, http.MethodPost, "/containers/"+containerID+"/kill", nil)
	if err != nil {
		return err
	}
	if status == http.StatusNotFound {
		return nil
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("kill %s: %s: %w", containerID, daemonMessage(out), ErrDaemon)
	}
	return nil
}

// InspectUsage returns a one-shot stats reading for a container.
func (b *DockerBackend) InspectUsage(ctx context.Context, containerID string) (UsageSnapshot, error) {
	status, out, err := b.do(ctx, http.MethodGet, "/containers/"+containerID+"/stats?stream=false", nil)
	if err != nil {
		return UsageSnapshot{}, err
	}
	if status == http.StatusNotFound {
		return UsageSnapshot{}, fmt.Errorf("container %s: %w", containerID, ErrNoSuchContainer)
	}
	if status < 200 || status >= 300 {
		return UsageSnapshot{}, fmt.Errorf("stats %s: %s: %w", containerID, daemonMessage(out), ErrDaemon)
	}
	var stats struct {
		MemoryStats struct {
			Usage int64 `json:"usage"`
		} `json:"memory_stats"`
		CPUStats struct {
			CPUUsage struct {
				TotalUsage int64 `json:"total_usage"`
			} `json:"cpu_usage"`
		} `json:"cpu_stats"`
		PrecpuStats struct {
			CPUUsage struct {
				TotalUsage int64 `json:"total_usage"`
			} `json:"cpu_usage"`
		} `json:"precpu_stats"`
	}
	if err := json.Unmarshal(out, &stats); err != nil {
		return UsageSnapshot{}, fmt.Errorf("decode stats: %w", err)
	}
	return UsageSnapshot{MemBytes: stats.MemoryStats.Usage}, nil
}
