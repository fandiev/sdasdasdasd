# Запуск из PowerShell:
# .\publish-github.ps1 -RepositoryUrl "https://github.com/USERNAME/conference-space.git"
param(
    [Parameter(Mandatory = $true)]
    [string]$RepositoryUrl
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if ($RepositoryUrl -notmatch '^https://github\.com/[a-zA-Z0-9-]+/[a-zA-Z0-9_.-]+(\.git)?$') {
    throw 'Укажите ссылку на репозиторий вида https://github.com/USERNAME/conference-space.git'
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Git не найден. Установите Git for Windows с https://git-scm.com/downloads/win'
}
if (-not (Test-Path .git)) { git init -b main; if ($LASTEXITCODE -ne 0) { throw 'Не удалось создать локальный Git-репозиторий.' } }
git add .
if ($LASTEXITCODE -ne 0) { throw 'Не удалось подготовить файлы.' }
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
    git commit -m 'Initial commit: conference space booking website'
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось создать коммит. Настройте git config user.name и user.email.' }
}
git branch -M main
$existing = git remote get-url origin 2>$null
if ($LASTEXITCODE -eq 0) {
    if ($existing.Trim().TrimEnd('/') -ne $RepositoryUrl.Trim().TrimEnd('/')) {
        throw "Уже настроен другой origin: $existing. Измените его вручную, чтобы не отправить код в чужой репозиторий."
    }
} else {
    git remote add origin $RepositoryUrl
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось добавить удалённый репозиторий.' }
}
Write-Host 'Отправка проекта на GitHub...'
git push -u origin main
if ($LASTEXITCODE -ne 0) { throw 'Загрузка не удалась. Проверьте, что репозиторий создан и вход в GitHub выполнен.' }
Write-Host "Готово! Проект загружен: $RepositoryUrl" -ForegroundColor Green
