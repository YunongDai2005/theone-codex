// Keep concurrent feature work in service.ts untouched. Only release metadata is
// normalized; protocol versions, history source identities and data paths survive.
export function releaseSource(source, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Expected a stable package version')
  return source.replace(/(\bversion:\s*)(['"])\d+\.\d+\.\d+(?:-[\w.-]+)?\2/g, (_m, prefix) => `${prefix}'${version}'`)
    .replace(/new ReleaseChecker\((['"])\d+\.\d+\.\d+(?:-[\w.-]+)?\1\)/g, `new ReleaseChecker('${version}')`)
    .replace(/(\bname:\s*)(['"])gpt-theone\2/g, (_m, prefix) => `${prefix}'theone'`)
}

export function dependencyInputs(inputs) {
  return Object.keys(inputs).filter(path => /(?:^|\/)node_modules\//.test(path.replaceAll('\\', '/')))
}
