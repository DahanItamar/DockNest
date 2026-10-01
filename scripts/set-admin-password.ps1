$ErrorActionPreference = 'Stop'
$previousOutputEncoding = $OutputEncoding
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    & npm.cmd run setup
    if ($LASTEXITCODE -ne 0) { throw 'Local setup failed.' }
    Write-Host 'Choose the shared system password (4-16 characters). Changing it signs out everyone and invalidates pending invitations.'
    $secret = Read-Host 'Main password' -AsSecureString
    $confirm = Read-Host 'Confirm password' -AsSecureString
    $firstPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    $secondPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($confirm)
    try {
        $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($firstPtr)
        $confirmation = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secondPtr)
        if ($password -cne $confirmation) { throw 'Passwords do not match.' }
        if ($password.Length -lt 4 -or $password.Length -gt 16) { throw 'Choose a password between 4 and 16 characters. Please run the command again.' }
        $result = @{ password = $password } | ConvertTo-Json -Compress | & node scripts/admin-password.js password
        if ($LASTEXITCODE -ne 0) {
            $failure = $result | ConvertFrom-Json
            if ($failure.error) { throw $failure.error }
            throw 'Password setup failed. Confirm Node.js 24 or newer is installed.'
        }
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($firstPtr)
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secondPtr)
        $password = $null
        $confirmation = $null
    }
    $setup = $result | ConvertFrom-Json
    if ($setup.enrollmentRequired) {
        Write-Host 'Opening your administrator QR. Scan it and save the recovery codes.'
        Start-Process -FilePath $setup.enrollmentFile -WindowStyle Hidden
        $code = Read-Host 'Six-digit code from your authenticator app'
        $confirmationResult = @{ code = $code } | ConvertTo-Json -Compress | & node scripts/admin-password.js confirm
        if ($LASTEXITCODE -ne 0) {
            $failure = $confirmationResult | ConvertFrom-Json
            if ($failure.error) { throw $failure.error }
            throw 'Authenticator confirmation failed.'
        }
    }
    Write-Host 'Ready. Open http://127.0.0.1:3000 and sign in with Password and 2FA code. Wait for a fresh code if you just used one.'
} finally {
    $OutputEncoding = $previousOutputEncoding
    Pop-Location
}
