#!/usr/bin/perl
# Busca el error que dejó colgadas varias pantallas:
#
#   render();                       <- se ejecuta acá arriba
#   ...
#   const activo = c => ...;        <- pero el helper se declara acá abajo
#
# `const`/`let` no se izan como `function`: hasta que corre su línea están en la
# "zona muerta temporal" (TDZ) y usarlas tira
# "Cannot access 'X' before initialization". Como el módulo se corta ahí, la
# pantalla queda con el "Cargando…" puesto y sin ningún mensaje de error.
#
# Nivel superior = columna 0. Es la convención de todas las páginas de Cirene y
# es mucho más confiable que contar llaves, porque los template literals de estas
# páginas están llenos de `{` y `}` dentro de strings.
#
# Uso: perl tools/check-tdz.pl *.html

use strict;
use warnings;

my $hallazgos = 0;

for my $file (@ARGV) {
  open my $fh, '<', $file or die "no puedo abrir $file: $!\n";
  my @todas = <$fh>;
  close $fh;

  my ($ini, $fin);
  for my $i (0 .. $#todas) {
    $ini = $i if !defined($ini) && $todas[$i] =~ /<script type="module">/;
    $fin = $i if defined($ini) && !defined($fin) && $i > $ini && $todas[$i] =~ m{</script>};
  }
  next unless defined $ini && defined $fin;

  my $arranque;      # primera sentencia ejecutable de nivel superior
  my @decls;         # [nombre, línea, es_función]
  my %usos;          # nombre => primera línea donde aparece
  my %en_funcion;    # nombre => línea, si aparece dentro del cuerpo de una función
  my $dentro_fn = 0; # los cuerpos de función arrancan en columna 0 y cierran con } en columna 0

  for my $i ($ini + 1 .. $fin - 1) {
    my $ln   = $i + 1;
    my $code = $todas[$i];
    $code =~ s{^(\s*)//.*$}{$1};

    my $col0 = $code =~ /^[^\s]/;
    if ($col0 && $code =~ /^(?:async\s+)?function\s/) { $dentro_fn = 1; }
    elsif ($col0 && $code =~ /^\}/)                   { $dentro_fn = 0; }
    elsif ($col0 && $code !~ /^\s*$/ && $dentro_fn && $code !~ /^\}/) { }

    if ($col0 && $code =~ /^(?:const|let)\s+([A-Za-z_\$][\w\$]*)\s*=(.*)$/) {
      # ¿guarda una función? (arrow o function). Esas son las peligrosas: aunque
      # el uso esté dentro de otra función declarada más abajo, el arranque la
      # puede llamar igual, y ahí la const todavía no existe.
      my ($nombre, $valor) = ($1, $2);
      my $es_fn = $valor =~ /=>|\bfunction\b/ ? 1 : 0;
      push @decls, [$nombre, $ln, $es_fn];
    }
    elsif ($col0 && !defined($arranque)
           && $code !~ /^(?:import|export|function|class|async\s+function|const|let|var|\}|\)|\]|`|\/\*|\*)/
           && $code =~ /\(|=/) {
      $arranque = $ln;
    }

    while ($code =~ /([A-Za-z_\$][\w\$]*)/g) {
      my $id = $1;
      $usos{$id} = $ln unless exists $usos{$id};
      # Un uso dentro de una función es el caso peligroso: la función se iza, así
      # que el arranque puede llamarla antes de que exista la const.
      $en_funcion{$id} = $ln if $dentro_fn && !exists $en_funcion{$id};
    }
  }

  next unless defined $arranque;

  my @malas;
  for my $d (@decls) {
    my ($nombre, $ln, $es_fn) = @$d;
    next if $ln < $arranque;                  # se declara antes de arrancar: bien
    my $primer_uso = $usos{$nombre} // $ln;
    if ($es_fn && exists $en_funcion{$nombre}) {
      push @malas, sprintf("  linea %-5d %-24s helper usado dentro de una funcion (linea %d) que el arranque puede llamar",
                           $ln, $nombre, $en_funcion{$nombre});
    } elsif ($primer_uso < $ln) {
      push @malas, sprintf("  linea %-5d %-24s se usa desde la linea %d", $ln, $nombre, $primer_uso);
    }
  }

  if (@malas) {
    $hallazgos += scalar @malas;
    print "$file  (arranque en la linea $arranque)\n";
    print "$_\n" for @malas;
    print "\n";
  }
}

if ($hallazgos) {
  print "$hallazgos declaraciones sospechosas de zona muerta temporal.\n";
  print "Revisar: si el uso corre antes de la declaracion, pasarlas a `function` (que se iza).\n";
  exit 1;
}
print "OK: ningun const/let de nivel superior se usa antes de declararse.\n";
exit 0;
