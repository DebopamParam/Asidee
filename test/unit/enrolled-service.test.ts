import { expect, test } from "bun:test"
import { serviceUnit } from "../../core/hosts"
import { defaultDirs, enrolledService, parseServiceUnit, serviceProblem, serviceUnitPath } from "../../core/state"

const unit = serviceUnit("deb", 1000, "/var/lib/asidee/1000", "/opt/asidee/releases/abc/asd")
const service = { unit: "asidee@1000.service", state: "/var/lib/asidee/1000", config: "/var/lib/asidee/1000/config" }

test("asd on an enrolled machine uses the folders its system service runs with, read from the unit enrollment wrote", () => {
  expect(parseServiceUnit(unit, "asidee@1000.service")).toEqual(service)
  const read: string[] = []
  const reader = (path: string) => { read.push(path); return unit }
  expect(enrolledService({}, "linux", 1000, reader)).toEqual(service)
  expect(read).toEqual([serviceUnitPath(1000)])
  expect(serviceUnitPath(1000)).toBe("/etc/systemd/system/asidee@1000.service")
  expect(defaultDirs({ XDG_STATE_HOME: "/x", XDG_CONFIG_HOME: "/y" }, service)).toEqual({ state: "/var/lib/asidee/1000", config: "/var/lib/asidee/1000/config" })
})

test("without an enrolled service, or with ASIDEE_STATE_DIR or ASIDEE_CONFIG_DIR set, asd keeps its own folders", () => {
  const missing = () => { throw new Error("ENOENT") }
  expect(enrolledService({}, "linux", 1000, missing)).toBeUndefined()
  expect(enrolledService({}, "darwin", 501, () => unit)).toBeUndefined()
  expect(enrolledService({ ASIDEE_STATE_DIR: "/mine" }, "linux", 1000, () => unit)).toBeUndefined()
  expect(enrolledService({ ASIDEE_CONFIG_DIR: "/mine" }, "linux", 1000, () => unit)).toBeUndefined()
  expect(enrolledService({}, "linux", 1000, () => "[Service]\nExecStart=/usr/bin/asd daemon run\n")).toBeUndefined()
  expect(defaultDirs({ ASIDEE_STATE_DIR: "/s", ASIDEE_CONFIG_DIR: "/c" })).toEqual({ state: "/s", config: "/c" })
})

test("asd never starts or replaces a daemon beside the service: it says how to start the service, or which asd to use", () => {
  const start = "This machine's Asidee runs as the system service asidee@1000.service, which is not answering. Start it with: sudo systemctl start asidee@1000.service (its log: journalctl -u asidee@1000.service)."
  expect(serviceProblem(service, undefined, "1.0.0+1")).toBe(start)
  expect(serviceProblem(service, { version: "1.0.0", build: "1.0.0+1", stopping: true }, "1.0.0+1")).toBe(start)
  expect(serviceProblem(service, { version: "0.9.0", build: "0.9.0+7" }, "1.0.0+1")).toBe("This asd is not the build the system service asidee@1000.service runs (version 0.9.0). Use /usr/local/bin/asd, which enrollment installed and an update of this machine changes with the service.")
  expect(serviceProblem(service, { version: "1.0.0", build: "1.0.0+1" }, "1.0.0+1")).toBeUndefined()
})
